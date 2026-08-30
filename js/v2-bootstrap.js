// ============================================
// BOOTSTRAP V2 — intégration navigation + helpers partagés
// ============================================

window.v2AdminClubs = window.v2AdminClubs || [];

async function v2PopulateAdminClubSelect(toolbarId) {
    const toolbar = document.getElementById(toolbarId);
    if (!toolbar) return;

    let sel = document.getElementById('v2AdminClubSelect');
    if (!sel) {
        sel = document.createElement('select');
        sel.id = 'v2AdminClubSelect';
        sel.className = 'form-control v2-club-select';
        sel.addEventListener('change', () => v2ReloadActiveSection());
        toolbar.prepend(sel);
    }

    if (!v2AdminClubs.length) {
        const { data, error } = await supabase.from('clubs').select('id, name').order('name');
        if (error) return;
        v2AdminClubs = data || [];
    }

    const current = sel.value;
    sel.innerHTML = '<option value="">— Sélectionner un club —</option>' +
        v2AdminClubs.map(c => `<option value="${c.id}">${escapeHtmlV2(c.name)}</option>`).join('');
    if (current) sel.value = current;
}

function v2ReloadActiveSection() {
    const active = document.querySelector('.content-section.active');
    if (!active) return;
    const map = {
        groupsSection: loadGroups,
        subscriptionsSection: loadSubscriptions,
        reportsSection: initReports,
        eventsSection: loadEvents,
        nfcCardsSection: loadNfcCards
    };
    const fn = map[active.id];
    if (fn) fn();
}

/* ---------- Navigation ---------- */

const V2_TABS = [
    { label: '🥊 Groupes', section: 'groupsSection', loader: loadGroups },
    { label: '💳 Abonnements', section: 'subscriptionsSection', loader: loadSubscriptions },
    { label: '📊 Rapports', section: 'reportsSection', loader: initReports },
    { label: '💰 Paiements', section: 'eventsSection', loader: loadEvents },
    { label: '📇 Cartes NFC', section: 'nfcCardsSection', loader: loadNfcCards }
];

function enhanceNavigation() {
    const navTabs = document.getElementById('navTabs');
    if (!navTabs) return;

    // setupNavigation() régénère les onglets legacy à chaque showMainApp()
    // et efface les nôtres : on purge puis on ré-ajoute systématiquement.
    navTabs.querySelectorAll('[data-v2tab]').forEach(b => b.remove());

    V2_TABS.forEach(tab => {
        // Ne jamais ajouter un onglet dont la section n'existe pas dans le DOM
        if (!document.getElementById(tab.section)) return;
        const btn = document.createElement('button');
        btn.className = 'nav-tab';
        btn.dataset.section = tab.section;
        btn.dataset.v2tab = '1';
        btn.textContent = tab.label;
        btn.addEventListener('click', function () {
            navTabs.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            this.classList.add('active');
            document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
            document.getElementById(tab.section).classList.add('active');
            if (typeof tab.loader === 'function') {
                try { tab.loader(); } catch (err) { console.error('Erreur loader ' + tab.section, err); }
            }
        });
        navTabs.appendChild(btn);
    });

    // Launchers pages dédiées NFC / TV — URL recalculée au clic
    const openPage = page => {
        const clubParam = (currentClub && currentClub !== 'admin') ? `?club=${currentClub.id}` : '';
        window.open(page + clubParam, '_blank');
    };
    [
        { label: '📱 NFC Validator', page: 'nfc.html' },
        { label: '✍️ Écrire Carte NFC', page: 'nfc-write.html' },
        { label: '📺 Affichage TV', page: 'tv.html' }
    ].forEach(l => {
        const btn = document.createElement('button');
        btn.className = 'nav-tab';
        btn.dataset.v2tab = '1';
        btn.textContent = l.label;
        btn.addEventListener('click', () => openPage(l.page));
        navTabs.appendChild(btn);
    });

    // Le compte "admin" dispose en plus d'un sélecteur de club ;
    // les comptes clubs utilisent directement leur propre club.
    if (currentClub === 'admin') {
        v2PopulateAdminClubSelect('groupsToolbar');
    }
}

// ============================================
// AUTO-RÉPARATION DE LA NAVIGATION V2
// setupNavigation() (legacy) vide #navTabs à chaque affichage de l'app.
// Si showMainApp() est appelé avant que ce script ne soit chargé — ou si une
// erreur survient pendant le login — les onglets V2 disparaissent.
// L'observer détecte toute modification de #navTabs et ré-ajoute nos onglets
// dès qu'ils manquent. Fonctionne aussi si #navTabs est créé tardivement.
// ============================================
(function v2NavAutoRepair() {
    let observer = null;

    function attach(target, subtree) {
        if (observer) observer.disconnect();
        observer = new MutationObserver(() => {
            const nt = document.getElementById('navTabs');
            if (nt) {
                // navTabs existe : on surveille uniquement ce conteneur
                attach(nt, false);
                if (!nt.querySelector('[data-v2tab]')) {
                    // Micro-délai pour laisser finir la régénération legacy
                    setTimeout(enhanceNavigation, 50);
                }
            } else if (target !== document.body) {
                // navTabs a disparu du DOM : retour à la surveillance globale
                attach(document.body, true);
            }
        });
        observer.observe(target, { childList: true, subtree: subtree });
    }

    function start() {
        const navTabs = document.getElementById('navTabs');
        if (navTabs && !navTabs.querySelector('[data-v2tab]')) {
            enhanceNavigation();
        }
        attach(navTabs || document.body, !navTabs);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();

// Wrapper non intrusif de showMainApp existant
const _v2OriginalShowMainApp = window.showMainApp;
window.showMainApp = function () {
    if (typeof _v2OriginalShowMainApp === 'function') {
        try {
            _v2OriginalShowMainApp();
        } catch (err) {
            // Ne pas bloquer l'affichage de l'app si le legacy échoue
            console.error('Erreur showMainApp legacy:', err);
        }
    }
    enhanceNavigation();
};

/* ---------- QR sécurisés (tokens) ---------- */

async function generateMemberQrTokens() {
    const clubId = v2GetActiveClubId();
    if (!clubId) return;

    try {
        const [membersRes, cardsRes] = await Promise.all([
            supabase.from('members').select('id, first_name, last_name').eq('club_id', clubId),
            supabase.from('member_cards').select('member_id, public_token')
        ]);

        const tokenOf = {};
        (cardsRes.data || []).forEach(c => tokenOf[c.member_id] = c.public_token);

        const missing = (membersRes.data || []).filter(m => !tokenOf[m.id]);
        if (missing.length) {
            const rows = missing.map(m => ({ member_id: m.id, club_id: clubId }));
            const { error } = await supabase.from('member_cards').insert(rows);
            if (error) throw error;
            missing.forEach(m => { /* tokens régénérés ci-dessous */ });
            const { data: fresh } = await supabase
                .from('member_cards').select('member_id, public_token');
            (fresh || []).forEach(c => tokenOf[c.member_id] = c.public_token);
        }

        const base = location.origin + location.pathname.replace(/[^/]*$/, '');
        const lines = (membersRes.data || []).map(m => {
            const t = tokenOf[m.id];
            return t ? `${m.last_name} ${m.first_name} : ${base}public-member.html?t=${t}` : null;
        }).filter(Boolean);

        const modal = createDynamicModalV2();
        modal.querySelector('#qrTokensContent').innerHTML =
            `<p>${lines.length} lien(s) sécurisé(s). Le QR de la carte doit pointer vers ces URL.</p>
             <textarea class="form-control" rows="12" readonly style="font-size:.75rem">${lines.join('\n')}</textarea>`;
        openModal('qrTokensModal');
    } catch (err) {
        alert('Erreur: ' + err.message);
    }
}

function createDynamicModalV2() {
    let modal = document.getElementById('qrTokensModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'qrTokensModal';
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <h2>🔐 Liens QR sécurisés</h2>
                <button class="modal-close" onclick="closeModal('qrTokensModal')">&times;</button>
            </div>
            <div id="qrTokensContent"></div>
        </div>`;
    document.body.appendChild(modal);
    return modal;
}

document.addEventListener('DOMContentLoaded', () => {
    // Bouton QR sécurisés dans la section Cartes existante (sans modifier le HTML inline)
    const cardsSection = document.getElementById('cardsSection');
    if (cardsSection) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-info';
        btn.style.marginLeft = '10px';
        btn.textContent = '🔐 Générer liens QR sécurisés';
        btn.onclick = generateMemberQrTokens;
        cardsSection.querySelector('.card-header')?.appendChild(btn);
    }
});
