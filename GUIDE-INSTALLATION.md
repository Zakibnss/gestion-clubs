# 🥋 Gestion Club Kyokushin - Guide d'Installation Firebase

## 📋 Étapes d'Installation Complète

### 1️⃣ Créer un Projet Firebase

1. Allez sur [firebase.google.com](https://firebase.google.com)
2. Cliquez sur **"Get Started"** puis **"Add Project"**
3. Nom du projet : `club-kyokushin` (ou le nom que vous voulez)
4. Désactivez **Google Analytics** (optionnel, pas nécessaire pour ce projet)
5. Cliquez **"Create Project"**
6. Attendez quelques secondes que Firebase crée le projet

---

### 2️⃣ Créer une Application Web

1. Dans la console Firebase, sur la page d'accueil du projet
2. Cliquez sur l'icône **`</>`** (Web) pour ajouter une application web
3. Nom de l'app : `Club Kyokushin Web`
4. **NE cochez PAS** "Also set up Firebase Hosting" (on utilisera GitHub Pages)
5. Cliquez **"Register app"**

---

### 3️⃣ Copier la Configuration Firebase

Firebase va afficher un code comme ceci :

```javascript
const firebaseConfig = {
  apiKey: "AIzaSyXXXXXXXXXXXXXXXXXXXXXX",
  authDomain: "club-kyokushin.firebaseapp.com",
  databaseURL: "https://club-kyokushin-default-rtdb.firebaseio.com",
  projectId: "club-kyokushin",
  storageBucket: "club-kyokushin.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:xxxxxxxxxxxxx"
};
```

**📌 IMPORTANT : Copiez ces valeurs, vous en aurez besoin !**

---

### 4️⃣ Activer Realtime Database

1. Dans le menu gauche de Firebase Console, cliquez **"Build"** → **"Realtime Database"**
2. Cliquez **"Create Database"**
3. Choisissez la location : **Europe (ou votre région préférée)**
4. Mode de sécurité : Sélectionnez **"Start in test mode"** (on configurera la sécurité après)
5. Cliquez **"Enable"**

---

### 5️⃣ Configurer les Règles de Sécurité

1. Dans **Realtime Database**, cliquez sur l'onglet **"Rules"**
2. Remplacez le contenu par ce code :

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

3. Cliquez **"Publish"**

⚠️ **Note de Sécurité** : Ces règles permettent à tout le monde de lire et écrire. C'est parfait pour le développement, mais pour la production, vous devriez configurer des règles plus strictes.

**Règles de sécurité recommandées pour la production :**

```json
{
  "rules": {
    "members": {
      ".read": true,
      ".write": true,
      "$memberId": {
        ".validate": "newData.hasChildren(['id', 'lastName', 'firstName', 'dob'])"
      }
    },
    "clubs": {
      ".read": true,
      ".write": true
    },
    "attendance": {
      ".read": true,
      ".write": true
    }
  }
}
```

---

### 6️⃣ Modifier le Fichier index.html

1. Ouvrez le fichier **index.html** dans un éditeur de texte
2. Cherchez la section suivante (autour de la ligne 650) :

```javascript
// Firebase Configuration - REMPLACEZ PAR VOS VALEURS
const firebaseConfig = {
    apiKey: "VOTRE_API_KEY",
    authDomain: "VOTRE_AUTH_DOMAIN",
    databaseURL: "VOTRE_DATABASE_URL",
    projectId: "VOTRE_PROJECT_ID",
    storageBucket: "VOTRE_STORAGE_BUCKET",
    messagingSenderId: "VOTRE_MESSAGING_SENDER_ID",
    appId: "VOTRE_APP_ID"
};
```

3. Remplacez avec **VOS vraies valeurs** de Firebase (étape 3)

---

### 7️⃣ Modifier member-info.html

1. Ouvrez **member-info.html**
2. Cherchez la même section `firebaseConfig`
3. Remplacez avec les **mêmes valeurs** que dans index.html

---

### 8️⃣ Héberger sur GitHub Pages

#### A. Créer un Compte GitHub (si vous n'en avez pas)

1. Allez sur [github.com](https://github.com)
2. Cliquez **"Sign up"** et créez votre compte gratuit

#### B. Créer un Nouveau Repository

1. Connectez-vous sur GitHub
2. Cliquez sur le bouton **"+"** en haut à droite → **"New repository"**
3. Nom du repository : `club-kyokushin`
4. Description : `Système de gestion pour club de Kyokushin`
5. Cochez **"Public"**
6. Cochez **"Add a README file"**
7. Cliquez **"Create repository"**

#### C. Upload des Fichiers

1. Dans votre repository, cliquez **"Add file"** → **"Upload files"**
2. Glissez-déposez ces fichiers :
   - `index.html`
   - `member-info.html`
3. Écrivez un message de commit : `Initial commit - Application complète`
4. Cliquez **"Commit changes"**

#### D. Activer GitHub Pages

1. Dans votre repository, cliquez sur **"Settings"** (onglet en haut)
2. Dans le menu de gauche, cliquez **"Pages"**
3. Sous **"Source"**, sélectionnez la branche **"main"**
4. Laissez le dossier sur **"/ (root)"**
5. Cliquez **"Save"**
6. Attendez 2-3 minutes

#### E. Accéder à Votre Application

Votre application sera accessible à l'URL :

```
https://votre-username.github.io/club-kyokushin/
```

Remplacez `votre-username` par votre nom d'utilisateur GitHub.

**Page publique pour parents :**
```
https://votre-username.github.io/club-kyokushin/member-info.html?id=KYO001
```

---

### 9️⃣ Mettre à Jour le Lien QR Code

1. Ouvrez **index.html**
2. Cherchez cette ligne (autour de la ligne 980) :

```javascript
const qrData = `https://votre-site.com/member-info.html?id=${member.id}`;
```

3. Remplacez par votre vraie URL GitHub Pages :

```javascript
const qrData = `https://votre-username.github.io/club-kyokushin/member-info.html?id=${member.id}`;
```

4. Sauvegardez et uploadez à nouveau sur GitHub

---

## 🎯 Utilisation de l'Application

### Sur PC :

1. Ouvrez `https://votre-username.github.io/club-kyokushin/`
2. Ajoutez des clubs avec logos
3. Ajoutez des adhérents
4. Générez des cartes

### Sur Smartphone :

1. Ouvrez la même URL sur votre smartphone
2. Allez dans l'onglet **"Scanner"**
3. Cliquez **"Ouvrir la Caméra"**
4. Scannez les QR codes des cartes pour valider les présences

### Pour les Parents :

1. Ils scannent le QR code de la carte de leur enfant avec n'importe quelle app de scan
2. Cela ouvre automatiquement la page `member-info.html` avec les informations
3. Ils voient : nom, prénom, date de naissance, groupe sanguin, date de fin d'abonnement, statut

---

## ✅ Vérification

Pour tester que tout fonctionne :

1. ✅ Firebase configuré
2. ✅ Realtime Database activée
3. ✅ Fichiers uploadés sur GitHub
4. ✅ GitHub Pages activé
5. ✅ Application accessible via URL
6. ✅ Lien QR code mis à jour

---

## 🔧 Dépannage

### L'application ne se charge pas

- Vérifiez que GitHub Pages est activé dans Settings → Pages
- Attendez 2-3 minutes après activation
- Vérifiez que les fichiers sont bien dans le repository

### Erreur Firebase

- Vérifiez que vous avez bien copié toutes les valeurs de `firebaseConfig`
- Vérifiez que Realtime Database est activée
- Vérifiez les règles de sécurité

### La caméra ne fonctionne pas

- Autorisez l'accès à la caméra dans les paramètres du navigateur
- Sur mobile, utilisez Chrome ou Safari
- L'application doit être en HTTPS (GitHub Pages le fait automatiquement)

---

## 📞 Support

Si vous avez des questions, relisez ce guide étape par étape. Toutes les étapes doivent être suivies dans l'ordre.

**Bonne chance avec votre système de gestion de club ! 🥋🇩🇿**