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

// Créer les dossiers si nécessaire
[DATA_DIR, MINECRAFT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 800,
    minHeight: 550,
    frame: false,
    resizable: true,
    backgroundColor: '#0f1e3d',
    icon: path.join(__dirname, 'assets', 'logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  // win.webContents.openDevTools(); // décommenter pour debug
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

// ─── Auth Microsoft (OAuth2 device flow simplifié) ─────────────────────────
// Note : pour un vrai token Microsoft, il faudra enregistrer une app sur Azure
// et remplacer CLIENT_ID par le vôtre. Voici le flux complet.
const MS_CLIENT_ID = 'VOTRE_CLIENT_ID_AZURE'; // à remplacer
const MS_TENANT = 'consumers';

ipcMain.handle('accounts:ms-login', async () => {
  // Ouvre la page de connexion Microsoft dans le navigateur
  const authUrl = `https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize`
    + `?client_id=${MS_CLIENT_ID}`
    + `&response_type=code`
    + `&redirect_uri=https://login.live.com/oauth20_desktop.srf`
    + `&scope=XboxLive.signin%20offline_access`
    + `&prompt=select_account`;
  
  // Ouvre une fenêtre Electron pour l'auth
  const authWin = new BrowserWindow({
    width: 500, height: 650,
    title: 'Connexion Microsoft',
    backgroundColor: '#0f1e3d',
    parent: win,
    modal: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  authWin.loadURL(authUrl);

  return new Promise((resolve) => {
    authWin.webContents.on('did-navigate', async (e, url) => {
      if (url.startsWith('https://login.live.com/oauth20_desktop.srf')) {
        const urlObj = new URL(url);
        const code = urlObj.searchParams.get('code');
        authWin.close();
        if (code) {
          try {
            const result = await exchangeMicrosoftCode(code);
            const accounts = loadAccounts();
            const existing = accounts.findIndex(a => a.uuid === result.uuid);
            if (existing >= 0) accounts[existing] = result; else accounts.push(result);
            saveAccounts(accounts);
            resolve({ success: true, account: result });
          } catch (err) {
            resolve({ success: false, error: err.message });
          }
        } else {
          resolve({ success: false, error: 'Connexion annulée' });
        }
      }
    });
    authWin.on('closed', () => resolve({ success: false, error: 'Fenêtre fermée' }));
  });
});

async function exchangeMicrosoftCode(code) {
  // 1. Échanger le code contre un token Microsoft
  const msToken = await postJson('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    client_id: MS_CLIENT_ID,
    code,
    grant_type: 'authorization_code',
    redirect_uri: 'https://login.live.com/oauth20_desktop.srf',
    scope: 'XboxLive.signin offline_access'
  }, 'application/x-www-form-urlencoded');

  // 2. Authentification XBox Live
  const xblData = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msToken.access_token}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  });
  const xblToken = xblData.Token;
  const userHash = xblData.DisplayClaims.xui[0].uhs;

  // 3. Token XSTS
  const xstsData = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  });
  const xstsToken = xstsData.Token;

  // 4. Token Minecraft
  const mcData = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${userHash};${xstsToken}`
  });
  const mcToken = mcData.access_token;

  // 5. Profil Minecraft
  const profile = await getJson('https://api.minecraftservices.com/minecraft/profile', mcToken);

  return {
    id: profile.id,
    type: 'microsoft',
    username: profile.name,
    uuid: profile.id,
    accessToken: mcToken,
    refreshToken: msToken.refresh_token,
    expiresAt: Date.now() + (msToken.expires_in * 1000)
  };
}

function postJson(url, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const data = contentType === 'application/x-www-form-urlencoded'
      ? new URLSearchParams(body).toString()
      : JSON.stringify(body);
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Réponse invalide: ' + raw)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(url, token) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    https.get({ hostname: urlObj.hostname, path: urlObj.pathname, headers: { Authorization: `Bearer ${token}` } }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error(raw)); } });
    }).on('error', reject);
  });
}

// ─── IPC : lancement Minecraft ─────────────────────────────────────────────
const SERVER_IP = 'herocraft.servegame.com';
const SERVER_PORT = 25565;

ipcMain.handle('game:launch', async (e, { accountId, version, ram }) => {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) return { success: false, error: 'Compte introuvable' };

  try {
    // Vérifie si Java est installé
    const javaOk = await checkJava();
    if (!javaOk) return { success: false, error: 'Java non trouvé. Installe Java 17+ depuis java.com' };

    // Lance via minecraft-launcher-core (ou direct jar si installé)
    const versionDir = path.join(MINECRAFT_DIR, 'versions', version);
    const jarPath = path.join(versionDir, `${version}.jar`);

    if (!fs.existsSync(jarPath)) {
      return { success: false, error: `Version ${version} non installée. Lance d'abord le launcher officiel Mojang pour l'installer, ou utilise le bouton Installer.` };
    }

    // Arguments JVM
    const args = buildLaunchArgs({ account, version, ram, versionDir });
    
    win.webContents.send('launch:status', { step: 'Lancement de Minecraft…', progress: 90 });

    const proc = spawn('java', args, { detached: true, stdio: 'ignore' });
    proc.unref();

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

function checkJava() {
  return new Promise(resolve => {
    exec('java -version', err => resolve(!err));
  });
}

function buildLaunchArgs({ account, version, ram, versionDir }) {
  const nativesDir = path.join(versionDir, 'natives');
  const isCrack = account.type === 'crack';
  
  return [
    `-Xmx${ram}G`,
    `-Xms512M`,
    `-Djava.library.path=${nativesDir}`,
    `-cp`, path.join(versionDir, `${version}.jar`),
    'net.minecraft.client.main.Main',
    '--username', account.username,
    '--version', version,
    '--gameDir', MINECRAFT_DIR,
    '--assetsDir', path.join(MINECRAFT_DIR, 'assets'),
    '--accessToken', isCrack ? 'null' : account.accessToken,
    '--uuid', account.uuid,
    '--userType', isCrack ? 'legacy' : 'msa',
    '--server', SERVER_IP,
    '--port', String(SERVER_PORT)
  ];
}

// ─── IPC : utilitaires ─────────────────────────────────────────────────────
ipcMain.handle('app:get-data-dir', () => DATA_DIR);
ipcMain.on('open-external', (e, url) => shell.openExternal(url));
