const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const { exec, spawn } = require('child_process');

// ─── Chemins ───────────────────────────────────────────────────────────────
const DATA_DIR = path.join(os.homedir(), '.herocraft-launcher');
const MINECRAFT_DIR = path.join(DATA_DIR, 'minecraft');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

[DATA_DIR, MINECRAFT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 900, height: 600, minWidth: 800, minHeight: 550,
    frame: false, resizable: true, backgroundColor: '#0f1e3d',
    icon: path.join(__dirname, 'assets', 'logo.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── IPC : fenêtre ─────────────────────────────────────────────────────────
ipcMain.on('window:close', () => win.close());
ipcMain.on('window:minimize', () => win.minimize());
ipcMain.on('window:maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());

// ─── IPC : comptes ─────────────────────────────────────────────────────────
function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
  catch { return []; }
}
function saveAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

ipcMain.handle('accounts:get', () => loadAccounts());

ipcMain.handle('accounts:add-crack', (e, username) => {
  const accounts = loadAccounts();
  const existing = accounts.find(a => a.username === username && a.type === 'crack');
  if (existing) return { success: true, account: existing };
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) return { success: false, error: 'Pseudo invalide (3-16 caractères, lettres/chiffres/_)' };
  const account = { id: Date.now().toString(), type: 'crack', username, uuid: `offline-${username}` };
  accounts.push(account);
  saveAccounts(accounts);
  return { success: true, account };
});

ipcMain.handle('accounts:remove', (e, id) => {
  const accounts = loadAccounts().filter(a => a.id !== id);
  saveAccounts(accounts);
  return { success: true };
});

// ─── Auth Microsoft — Client ID public Minecraft (aucun Azure requis) ──────
// Ce Client ID est celui utilisé par le launcher officiel Minecraft Java Edition.
// Il permet la connexion OAuth2 Microsoft complète sans créer d'app Azure.
const MS_CLIENT_ID = '00000000402b5328';  // Client ID public Microsoft/Minecraft
const MS_REDIRECT  = 'https://login.live.com/oauth20_desktop.srf';
const MS_SCOPE     = 'service::user.auth.xboxlive.com::MBI_SSL';

ipcMain.handle('accounts:ms-login', async () => {
  const authUrl =
    'https://login.live.com/oauth20_authorize.srf'
    + `?client_id=${MS_CLIENT_ID}`
    + `&response_type=code`
    + `&redirect_uri=${encodeURIComponent(MS_REDIRECT)}`
    + `&scope=${encodeURIComponent(MS_SCOPE)}`
    + `&prompt=select_account`;

  const authWin = new BrowserWindow({
    width: 520, height: 680,
    title: 'Connexion Microsoft — HeroCraft',
    backgroundColor: '#ffffff',
    parent: win, modal: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  // Vider les cookies pour forcer l'affichage de la page de connexion
  await authWin.webContents.session.clearStorageData({ storages: ['cookies'] });
  authWin.loadURL(authUrl);

  return new Promise((resolve) => {
    const checkUrl = (url) => {
      if (!url.startsWith(MS_REDIRECT)) return;
      const urlObj = new URL(url);
      const code = urlObj.searchParams.get('code');
      authWin.destroy();
      if (!code) return resolve({ success: false, error: 'Connexion annulée ou refusée.' });

      exchangeLiveCode(code)
        .then(result => {
          const accounts = loadAccounts();
          const idx = accounts.findIndex(a => a.uuid === result.uuid);
          if (idx >= 0) accounts[idx] = result; else accounts.push(result);
          saveAccounts(accounts);
          resolve({ success: true, account: result });
        })
        .catch(err => resolve({ success: false, error: err.message }));
    };

    authWin.webContents.on('did-navigate', (e, url) => checkUrl(url));
    authWin.webContents.on('did-redirect-navigation', (e, url) => checkUrl(url));
    authWin.on('closed', () => resolve({ success: false, error: 'Fenêtre fermée.' }));
  });
});

async function exchangeLiveCode(code) {
  // 1. Échanger le code Live contre un access_token Microsoft
  const liveToken = await postForm('https://login.live.com/oauth20_token.srf', {
    client_id:    MS_CLIENT_ID,
    code,
    grant_type:   'authorization_code',
    redirect_uri: MS_REDIRECT,
    scope:        MS_SCOPE,
  });

  if (liveToken.error) throw new Error(`Live token: ${liveToken.error_description || liveToken.error}`);

  // 2. XBox Live
  const xblRes = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName:   'user.auth.xboxlive.com',
      RpsTicket:  liveToken.access_token,   // pas de "d=" avec l'ancien endpoint Live
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType:    'JWT',
  });
  if (!xblRes.Token) throw new Error('Échec XBL: ' + JSON.stringify(xblRes));
  const xblToken  = xblRes.Token;
  const userHash  = xblRes.DisplayClaims.xui[0].uhs;

  // 3. XSTS
  const xstsRes = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties:   { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType:    'JWT',
  });
  if (!xstsRes.Token) {
    const code = xstsRes.XErr;
    const msg = {
      2148916233: 'Ce compte Microsoft n\'a pas de compte Xbox. Crée-en un sur xbox.com.',
      2148916235: 'Xbox Live n\'est pas disponible dans ton pays.',
      2148916238: 'Ce compte est un compte enfant. Un adulte doit l\'ajouter à une famille Xbox.',
    }[code] || `Erreur XSTS: ${code}`;
    throw new Error(msg);
  }
  const xstsToken = xstsRes.Token;

  // 4. Token Minecraft
  const mcRes = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${userHash};${xstsToken}`,
  });
  if (!mcRes.access_token) throw new Error('Échec auth Minecraft: ' + JSON.stringify(mcRes));
  const mcToken = mcRes.access_token;

  // 5. Profil Minecraft (vérifie que le jeu est acheté)
  const profile = await getJson('https://api.minecraftservices.com/minecraft/profile', mcToken);
  if (profile.error) throw new Error('Ce compte Microsoft ne possède pas Minecraft Java Edition.');

  return {
    id:           profile.id,
    type:         'microsoft',
    username:     profile.name,
    uuid:         profile.id,
    accessToken:  mcToken,
    refreshToken: liveToken.refresh_token,
    expiresAt:    Date.now() + (liveToken.expires_in * 1000),
  };
}

// ─── Helpers HTTP ───────────────────────────────────────────────────────────
function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error(raw)); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error(raw)); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname, path: u.pathname,
      headers: { Authorization: `Bearer ${token}` }
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error(raw)); } });
    }).on('error', reject);
  });
}

// ─── IPC : lancement Minecraft ─────────────────────────────────────────────
const SERVER_IP   = 'herocraft.servegame.com';
const SERVER_PORT = 25565;

ipcMain.handle('game:launch', async (e, { accountId, version, ram }) => {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) return { success: false, error: 'Compte introuvable.' };

  try {
    const javaOk = await checkJava();
    if (!javaOk) return { success: false, error: 'Java non trouvé. Installe Java 17+ depuis java.com' };

    const versionDir = path.join(MINECRAFT_DIR, 'versions', version);
    const jarPath    = path.join(versionDir, `${version}.jar`);

    if (!fs.existsSync(jarPath)) {
      return { success: false, error: `Version ${version} non installée. Lance le launcher Mojang officiel une fois pour l'installer.` };
    }

    win.webContents.send('launch:status', { step: 'Lancement de Minecraft…', progress: 90 });
    const proc = spawn('java', buildLaunchArgs({ account, version, ram, versionDir }), { detached: true, stdio: 'ignore' });
    proc.unref();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function checkJava() {
  return new Promise(resolve => exec('java -version', err => resolve(!err)));
}

function buildLaunchArgs({ account, version, ram, versionDir }) {
  const isCrack = account.type === 'crack';
  return [
    `-Xmx${ram}G`, `-Xms512M`,
    `-Djava.library.path=${path.join(versionDir, 'natives')}`,
    `-cp`, path.join(versionDir, `${version}.jar`),
    'net.minecraft.client.main.Main',
    '--username',    account.username,
    '--version',     version,
    '--gameDir',     MINECRAFT_DIR,
    '--assetsDir',   path.join(MINECRAFT_DIR, 'assets'),
    '--accessToken', isCrack ? 'null' : account.accessToken,
    '--uuid',        account.uuid,
    '--userType',    isCrack ? 'legacy' : 'msa',
    '--server',      SERVER_IP,
    '--port',        String(SERVER_PORT),
  ];
}

// ─── IPC : utilitaires ─────────────────────────────────────────────────────
ipcMain.handle('app:get-data-dir', () => DATA_DIR);
ipcMain.on('open-external', (e, url) => shell.openExternal(url));
