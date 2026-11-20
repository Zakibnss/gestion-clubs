# 🥋 Système de Gestion Club Kyokushin avec Firebase

Application web professionnelle pour la gestion d'un club de Kyokushin Karate avec synchronisation Firebase en temps réel.

## ✨ Fonctionnalités

### 📊 Tableau de Bord
- Statistiques en temps réel (total adhérents, actifs, expirés, clubs)
- Recherche rapide par ID
- Export Excel de tous les adhérents
- Vue d'ensemble complète

### 🏢 Gestion Multi-Clubs
- Ajout de clubs avec logos personnalisés
- Gestion centralisée de plusieurs clubs
- Association automatique des adhérents à leur club

### ➕ Gestion des Adhérents
- Ajout manuel avec formulaire complet
- Informations : ID, nom, prénom, date de naissance, groupe sanguin
- Types d'abonnement : mensuel, trimestriel, semestriel, annuel
- Calcul automatique de la date de fin d'abonnement
- Statut en temps réel (ACTIF / EXPIRÉ)

### 📁 Import/Export Excel
- Import en masse depuis fichiers Excel/CSV
- Template fourni pour faciliter l'import
- Export Excel de toutes les données

### 🎫 Génération de Cartes d'Adhérent
- Design professionnel 742x466 pixels
- Upload d'arrière-plan personnalisable
- Génération multiple (sélection de plusieurs adhérents)
- Informations affichées :
  - Logo du club
  - Nom du club avec sous-titre
  - ID, nom de famille, prénom
  - Date de naissance
  - Groupe sanguin (en français et arabe)
  - QR code avec toutes les infos
- Export PNG haute résolution pour impression

### 📱 Scanner de Présence avec QR Code
- **Dans l'application (Coach/Admin)** :
  - Scan QR avec caméra smartphone
  - Validation automatique de présence
  - Enregistrement dans Firebase
  - Alertes pour abonnements expirés
  - Saisie manuelle d'ID possible

- **Hors application (Parents)** :
  - Page publique accessible via QR code
  - Affichage des informations seulement
  - Pas de validation de présence
  - Design responsive mobile

### 📋 Historique des Présences
- Liste complète de toutes les présences validées
- Date/heure, nom, club, statut
- Recherche en temps réel
- Export Excel des présences

### 🔄 Synchronisation Firebase
- Base de données en temps réel
- Accessible depuis n'importe quel appareil
- PC et smartphone synchronisés
- Données sauvegardées en ligne

## 📅 Prochaines séances (fiche adhérent)

La fiche `member-info.html` affiche automatiquement :

1. **La prochaine séance** de l'adhérent (carte « Prochaine séance ») ;
2. **Les suivantes** via le bouton **Voir tout / Masquer** (`sessions[1..N]`).

Les occurrences sont **calculées à la volée** par `js/next-sessions.js`.
Aucune date future n'est stockée : le vieux générateur et la table
d'occurrences pré-calculées ont été supprimés.

### Source de vérité (schéma Supabase réel)

| Donnée | Emplacement |
| --- | --- |
| Groupe de l'adhérent | `members.current_group_id` → `groups.id` |
| Planning hebdomadaire | `training_sessions` (`day_of_week` 1–7, `start_time`, `end_time`, `coach`, `is_active`, rattaché par `group_id` ou `group_type` selon le déploiement) |
| Séances ponctuelles réelles | `sessions` (`group_id`, `session_date`, `start_time`, `status`) |
| Annulation | `sessions.status = 'cancelled'` |

> ⚠️ `groups.schedule`, `groups.extra_sessions`, les RPC de génération
> et la table d'occurrences pré-calculées ne sont plus utilisés.

### Algorithme de calcul

1. résolution `member → groupe` (avec lecture directe de `groups` en repli) ;
2. date du jour et heure courante dans le fuseau **`Africa/Algiers`** ;
3. lecture des créneaux **actifs** de `training_sessions` pour ce `group_id` ;
4. projection sur **8 semaines** (56 jours) de `day_of_week` → dates ;
5. créneau déjà terminé aujourd'hui ignoré (`end_time`, ou `start_time` à défaut) ;
6. ajout des séances ponctuelles **déjà présentes** dans `sessions`
   (`session_date >= aujourd'hui`, `status <> 'cancelled'`) ;
7. tri par date + heure, déduplication (date + heure), limite `limit`.

Une séance ponctuelle saisie manuellement est **prioritaire** sur un
créneau récurrent identique (même date, même heure).

### Ajouter une séance ponctuelle

Uniquement **manuellement** dans la table `sessions` (le coach peut
toujours le faire depuis l'onglet Groupes → « Séances en plus », ou en SQL) :

```sql
insert into public.sessions
    (club_id, group_id, session_date, start_time, end_time, status, group_type)
values
    ('<club_id>', '<group_id>', '2026-12-05', '10:00:00', '12:00:00',
     'waiting', 'Stage technique');
```

Le module n'écrit jamais dans `sessions` et n'y crée aucune date future.

### Badges affichés

| Badge | Signification |
| --- | --- |
| `Entraînement` | Séance récurrente du planning |
| `Séance supplémentaire` | Ligne manuelle de `sessions` |
| `Aujourd'hui` / `Demain` | Calculé dans le fuseau du club |

### Accessibilité

- Cartes en `role`/`aria-labelledby`, corps en `aria-live="polite"` ;
- Bouton **Voir tout** avec `aria-expanded` et `aria-controls` ;
- Fermeture de la liste avec **Échap** (focus rendu au bouton) ;
- Styles `:focus-visible` et respect de `prefers-reduced-motion`.

### Diagnostic SQL

Le fichier [`sql/019_next_sessions_cleanup.sql`](sql/019_next_sessions_cleanup.sql)
regroupe des requêtes **lecture seule** :

- planning récurrent actif (`training_sessions`) ;
- séances futures présentes dans `sessions` (à examiner) ;
- candidates probablement générées (correspondance date + heure + groupe) ;
- existence de l'ancienne table d'occurrences pré-calculées.

Les instructions `DELETE` / `DROP` y sont **commentées** : aucune
suppression n'est exécutée sans confirmation du coach.

Le fichier `sql/018_upcoming_sessions_diagnostic.sql` reste disponible
à titre historique pour le diagnostic de l'ancien schéma.

### Test rapide dans la console

```js
// Sur member-info.html?id=FL1 (F12 → Console)
await getUpcomingSessions('FL1', 10);      // { sessions, message, … }
await getUpcomingSessionsData('FL1', 5);   // même objet détaillé
UpcomingSessions.getState().lastData.message;
```

Valeurs de `reason` : `null` (OK), `no_member`, `no_client`,
`member_not_found`, `no_group`, `inactive_group`, `planning_error`,
`no_slots`, `none`, `load_error`.

Tests unitaires :

```bash
node --test tests/next-sessions.test.js
```

### Limites connues

- l'horizon est fixé à **8 semaines** (`HORIZON_DAYS = 56`) ;
- `sessions.end_time` est souvent `null` : l'heure de fin n'apparaît
  alors pas ;
- les séances ponctuelles sont affichées telles quelles, sans calcul
  de récurrence.

## 📦 Fichiers du Projet

1. **index.html** - Application principale complète
2. **member-info.html** - Page publique pour parents
3. **GUIDE-INSTALLATION.md** - Guide complet d'installation Firebase et GitHub Pages

## 🚀 Installation Rapide

### 1. Firebase Setup

1. Créez un projet sur [firebase.google.com](https://firebase.google.com)
2. Activez Realtime Database
3. Copiez votre configuration Firebase
4. Remplacez dans `index.html` et `member-info.html` :

```javascript
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

### 2. GitHub Pages Deployment

1. Créez un repository sur GitHub
2. Uploadez les fichiers `index.html` et `member-info.html`
3. Activez GitHub Pages dans Settings → Pages
4. Votre app sera accessible à : `https://votre-username.github.io/nom-repo/`

### 3. Configuration QR Code

Dans `index.html`, ligne ~980, remplacez :

```javascript
const qrData = `https://votre-site.com/member-info.html?id=${member.id}`;
```

Par votre vraie URL GitHub Pages :

```javascript
const qrData = `https://votre-username.github.io/club-kyokushin/member-info.html?id=${member.id}`;
```

## 📱 Utilisation

### Sur PC

1. Ouvrez l'application dans votre navigateur
2. Ajoutez des clubs avec logos
3. Ajoutez des adhérents
4. Générez des cartes avec arrière-plan personnalisé
5. Exportez les cartes en PNG

### Sur Smartphone (Scanner)

1. Ouvrez la même URL sur votre smartphone
2. Allez dans "Scanner de Présence"
3. Cliquez "Ouvrir la Caméra"
4. Scannez les QR codes pour valider les présences
5. Les données sont synchronisées en temps réel avec Firebase

### Pour les Parents

1. Scannent le QR code de la carte de leur enfant
2. Page publique s'ouvre automatiquement
3. Voient toutes les informations (lecture seule)
4. Pas de possibilité de modifier ou valider

## 🎨 Design

- Police principale : **Poppins**
- Police titres : **Montserrat**
- Couleur primaire : **#21808d** (Teal)
- Design responsive mobile
- Animations fluides
- Interface moderne et professionnelle

## 📊 Structure de Données Firebase

```
club-kyokushin/
├── clubs/
│   ├── clubId1/
│   │   ├── name: "FLAME CLUB"
│   │   ├── logo: "data:image/..."
│   │   └── createdAt: timestamp
│   └── clubId2/...
│
├── members/
│   ├── memberId/
│   │   ├── id: "KYO001"
│   │   ├── clubId: "clubId1"
│   │   ├── lastName: "BENALI"
│   │   ├── firstName: "Ahmed"
│   │   ├── dob: "2005-03-15"
│   │   ├── bloodType: "A+"
│   │   ├── subscription: "monthly"
│   │   ├── startDate: "2025-01-01"
│   │   └── createdAt: timestamp
│   └── ...
│
└── attendance/
    ├── attendanceId1/
    │   ├── memberId: "KYO001"
    │   ├── lastName: "BENALI"
    │   ├── firstName: "Ahmed"
    │   ├── clubId: "clubId1"
    │   ├── status: "ACTIVE"
    │   └── timestamp: timestamp
    └── ...
```

## 🔒 Sécurité

### Règles Firebase (Test Mode)

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

### Règles Firebase (Production - Recommandé)

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

## 🛠️ Technologies Utilisées

- **HTML5/CSS3/JavaScript** - Frontend
- **Firebase Realtime Database** - Base de données cloud
- **html5-qrcode** - Scan QR avec caméra
- **QRCode.js** - Génération de QR codes
- **html2canvas** - Export PNG des cartes
- **SheetJS** - Import/Export Excel
- **GitHub Pages** - Hébergement gratuit

## 📖 Documentation Complète

Consultez **GUIDE-INSTALLATION.md** pour :
- Configuration Firebase étape par étape
- Déploiement GitHub Pages détaillé
- Résolution de problèmes
- Configuration de la sécurité

## ✅ Checklist de Déploiement

- [ ] Projet Firebase créé
- [ ] Realtime Database activée
- [ ] Configuration Firebase copiée dans les fichiers HTML
- [ ] Repository GitHub créé
- [ ] Fichiers uploadés sur GitHub
- [ ] GitHub Pages activé
- [ ] URL QR code mise à jour dans index.html
- [ ] Test de l'application sur PC
- [ ] Test du scanner sur smartphone
- [ ] Test de la page publique pour parents

## 🎯 Workflow Complet

1. **Admin ajoute des clubs** (avec logos)
2. **Admin ajoute des adhérents** (formulaire ou import Excel)
3. **Admin génère des cartes** (avec arrière-plan personnalisé)
4. **Admin exporte les cartes en PNG**
5. **Impression des cartes** (742x466 pixels)
6. **Distribution des cartes aux adhérents**
7. **Coach scanne les QR codes** (validation présence sur smartphone)
8. **Parents scannent les QR codes** (consultation infos uniquement)
9. **Export des présences** (Excel pour suivi)

## 📞 Support

Pour toute question ou problème, consultez le **GUIDE-INSTALLATION.md** qui contient toutes les réponses aux questions fréquentes.

## 🌟 Fonctionnalités Futures Possibles

- Authentification admin
- Gestion des paiements
- Notifications push
- Export PDF des cartes
- Statistiques avancées
- Gestion des ceintures/grades
- Calendrier des cours
- Messagerie parents-coach

## 📄 Licence

Ce projet est libre d'utilisation pour tous les clubs de Kyokushin.

---

**Développé avec ❤️ pour la communauté Kyokushin 🥋🇩🇿**