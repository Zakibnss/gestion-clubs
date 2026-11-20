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
2. **Toutes les prochaines séances** via le bouton **Voir tout / Masquer**.

### Source de vérité (schéma Supabase réel)

| Donnée | Emplacement |
| --- | --- |
| Groupe de l'adhérent | `members.current_group_id` → `groups.id` |
| Repli multi-groupes | `group_members` où `end_date IS NULL` |
| Planning hebdomadaire | `groups.schedule` (jsonb `{ "mardi": "18:30", … }`) |
| Séances ponctuelles | `groups.extra_sessions` (jsonb, migration 016) |
| Pauses | `groups.pause_start_date` / `pause_end_date` (migration 016) |
| Saison | `groups.start_date` / `groups.end_date` |
| Annulation | `sessions.status = 'cancelled'` |

> ⚠️ La RPC `group_planned_sessions` n'est pas déployée sur la base
> actuelle (HTTP 404). La génération des occurrences est donc faite
> **côté client** par `js/upcoming-sessions.js`, avec les mêmes règles
> que la migration 016. Dès que la RPC est déployée, le module peut
> être branché dessus sans changer l'interface.

### Algorithme de calcul

Pour chaque groupe de l'adhérent, le module :

1. part de la date du jour dans le fuseau **`Africa/Algiers`** ;
2. borne la période par `start_date` / `end_date` du groupe et un
   horizon de **180 jours** ;
3. génère les occurrences du planning hebdomadaire (`schedule`) ;
4. ajoute les séances supplémentaires (`extra_sessions`) ;
5. retire les pauses du groupe (`pause_*`) ;
6. retire les séances annulées (`sessions.status = 'cancelled'`) ;
7. exclut les séances déjà passées aujourd'hui (heure de début
   dépassée), tout en gardant une séance en cours si `end_time` existe ;
8. trie par date puis heure et déduplique (date + heure + groupe).

Une séance supplémentaire est **prioritaire** sur un créneau
récurrent identique (même date, même heure).

### Ajouter une séance supplémentaire

Deux possibilités :

- **Via l'application** : onglet Groupes → « Séances en plus »
  (écrit dans `groups.extra_sessions`) ;
- **Via SQL** (si la migration 016 est appliquée) :

```sql
update public.groups
set extra_sessions = coalesce(extra_sessions, '[]'::jsonb) ||
    jsonb_build_array(jsonb_build_object(
        'date', '2026-12-05',
        'time', '10:00',
        'notes', 'Stage technique'
    ))
where id = '<group_id>';
```

Le module accepte aussi les formes `{ start_time, end_time, room }`
et la chaîne `"2026-12-05 10:00"`.

### Badges affichés

| Badge | Signification |
| --- | --- |
| `Entraînement` | Séance récurrente du planning |
| `Séance supplémentaire` | Entrée de `extra_sessions` |
| `Stage` / `Compétition` | Détecté dans les notes / le libellé |
| `Aujourd'hui` | Séance le jour même (fuseau du club) |
| `Demain` | Séance le lendemain |

### Accessibilité

- Cartes en `role`/`aria-labelledby`, corps en `aria-live="polite"` ;
- Bouton **Voir tout** avec `aria-expanded` et `aria-controls` ;
- Fermeture de la liste avec **Échap** (focus rendu au bouton) ;
- Styles `:focus-visible` et respect de `prefers-reduced-motion`.

### Diagnostic SQL

Le fichier [`sql/018_upcoming_sessions_diagnostic.sql`](sql/018_upcoming_sessions_diagnostic.sql)
regroupe des requêtes **lecture seule** :

- colonnes réellement présentes (`groups`, `sessions`, …) ;
- existence des colonnes optionnelles de la migration 016 ;
- existence de la RPC `group_planned_sessions` ;
- résolution `membre → groupe` ;
- planning brut, pauses et séances supplémentaires ;
- séances annulées ;
- aperçu des 20 prochaines occurrences ;
- contrôle du nombre d'occurrences par source.

Remplacer `'FL1'` par l'identifiant de l'adhérent à contrôler.

### Test rapide dans la console

```js
// Sur member-info.html?id=FL1 (F12 → Console)
await getUpcomingSessions('FL1', 5);       // tableau des 5 prochaines séances
await getUpcomingSessionsData('FL1', 5);   // détail (reason, groupName, all…)
UpcomingSessions.getState().lastData.reason;
```

Valeurs de `reason` : `null` (OK), `no_group`, `member_not_found`,
`no_member`, `no_client`, `load_error`.

Tests unitaires :

```bash
node --test tests/upcoming-sessions.test.js
```

### Limites connues

- Pas de colonne `room` en base : la salle n'est affichée que si elle
  est fournie par `extra_sessions` ou par une future colonne ;
- `sessions.end_time` est souvent `null` : l'heure de fin n'apparaît
  alors pas ;
- `extra_sessions` / pauses nécessitent la migration `016` ;
- l'horizon est fixé à 180 jours (constante `HORIZON_DAYS`).

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