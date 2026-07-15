# HeroCraft Launcher

Launcher officiel du serveur **herocraft.servegame.com**

## 🚀 Compiler le .exe (Windows)

### Prérequis
- **Node.js 18+** → https://nodejs.org
- **Python 3** (pour certaines dépendances natives) → https://python.org

### Étapes

```bash
# 1. Ouvrir un terminal dans ce dossier
cd herocraft-launcher

# 2. Installer les dépendances
npm install

# 3. Compiler le .exe pour Windows
npm run build:win
```

Le fichier `.exe` apparaît dans le dossier **`dist/`** 🎉

---

## 🔐 Connexion Microsoft (optionnel)

Pour activer la connexion Microsoft officielle :

1. Va sur https://portal.azure.com
2. Crée une app : **Azure Active Directory → App registrations → New registration**
3. Nom : "HeroCraft Launcher", Type : "Personal Microsoft accounts only"
4. Redirect URI : `https://login.live.com/oauth20_desktop.srf`
5. Copie le **Client ID** affiché
6. Dans `src/main.js`, remplace `VOTRE_CLIENT_ID_AZURE` par ton Client ID

Sans ça, seul le mode **Crack** (comptes hors-ligne) fonctionne.

---

## 🛠️ Développement

```bash
# Lancer sans compiler (pour tester)
npm start

# Compiler pour macOS
npm run build:mac

# Compiler pour Linux (.AppImage)
npm run build:linux
```

---

## 📁 Structure

```
herocraft-launcher/
├── src/
│   ├── main.js        ← Processus principal Electron
│   ├── preload.js     ← Bridge sécurisé IPC
│   ├── index.html     ← Interface utilisateur
│   └── assets/
│       └── logo.png   ← Logo HeroCraft
├── package.json
└── README.md
```
