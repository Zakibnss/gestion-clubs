// ============================================
// TV DISPLAY LOGIC — V2
// Affichage plein écran pour TV du club (?club=<id>)
// ============================================

const SUPABASE_URL = 'https://gmoyoflorwaltuanfswn.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdtb3lvZmxvcndhbHR1YW5mc3duIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIxNTc0OTIsImV4cCI6MjA3NzczMzQ5Mn0.Yr0SFLvcPNbvRqNSjzwFdTZkrIz3Z6WZxcIyx8gwjZA';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const CLUB_ID = new URLSearchParams(location.search).get('club');

let currentSession = null;
let lastPresentCount = -1;
let celebrationShownFor = null;

/* ---------------- Horloge ---------------- */

function tickClock() {
    const now = new Date();
    document.getElementById('tvTime').textContent =
        now.toLocaleTimeString('fr-FR', { hour12: false });
    document.getElementById('tvDate').textContent =
        now.toLocaleDateString('ar-DZ', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}
setInterval(tickClock, 1000);
tickClock();

/* ---------------- Chronomètre calculé localement depuis les timestamps ---------------- */

function fmtChrono(ms) {
    if (ms < 0 || isNaN(ms)) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

function tickChrono() {
    const el = document.getElementById('chronoDisplay');
    if (!currentSession) { el.textContent = '00:00:00'; return; }

    let elapsed;
    if (currentSession.status === 'completed' && currentSession.session_ended_at && currentSession.session_started_at) {
        // Séance terminée : chrono figé sur la durée totale
        elapsed = new Date(currentSession.session_ended_at) - new Date(currentSession.session_started_at);
        showCelebration(currentSession.id);
    } else if (currentSession.status === 'paused') {
        // En pause : figé au moment de la pause
        const ref = currentSession.session_paused_at || new Date().toISOString();
        elapsed = currentSession.session_started_at
            ? new Date(ref) - new Date(currentSession.session_started_at)
            : 0;
    } else {
        // live : temps réel
        elapsed = currentSession.session_started_at
            ? Date.now() - new Date(currentSession.session_started_at)
            : 0;
    }

    el.textContent = fmtChrono(elapsed);
    document.getElementById('statusPill').className =
        'status-pill st-' + (currentSession.status === 'completed' ? 'waiting' : currentSession.status);
    document.getElementById('statusPill').textContent = {
        waiting: 'في انتظار بدء الحصة',
        live: 'الحصة جارية',
        paused: 'الحصة متوقفة مؤقتا',
        completed: 'انتهت الحصة'
    }[currentSession.status] || '';

    // Dépassement de durée : flash rouge si durée planifiée dépassée
    const durationMs = (parseInt(currentSession.duration, 10) || 0) * 60000;
    el.classList.toggle('over-time',
        !!durationMs && currentSession.status === 'live' && elapsed > durationMs);
    document.body.classList.toggle('over-flash',
        !!durationMs && currentSession.status === 'live' && elapsed > durationMs);
}

function showCelebration(sessionId) {
    if (celebrationShownFor === sessionId) return;
    celebrationShownFor = sessionId;
    const cel = document.getElementById('celebration');
    cel.classList.remove('hidden');
    setTimeout(() => cel.classList.add('hidden'), 8000);
}

setInterval(tickChrono, 1000);

/* ---------------- États d'affichage ---------------- */

function renderSessionState() {
    const running = currentSession && (currentSession.status === 'live' || currentSession.status === 'paused');
    document.getElementById('stateWaiting').classList.toggle('hidden', !!running);
    document.getElementById('stateRunning').classList.toggle('hidden', !running);
    if (!running) {
        document.body.classList.remove('over-flash');
        document.getElementById('attendeeCard').classList.add('hidden');
        lastPresentCount = -1;
    }
}

/* ---------------- Données club ---------------- */

async function loadClub() {
    if (!CLUB_ID) {
        document.getElementById('clubName').textContent = 'أضف ?club=<club_id> إلى الرابط';
        return;
    }
    const { data: club } = await supabaseClient.from('clubs')
        .select('name, logo').eq('id', CLUB_ID).maybeSingle();
    if (club) {
        document.getElementById('clubName').textContent = club.name || 'النادي';
        if (club.logo) document.getElementById('clubLogo').src = club.logo;
    }
}

async function loadCurrentSession() {
    if (!CLUB_ID) return;

    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabaseClient.from('sessions')
        .select('*')
        .eq('club_id', CLUB_ID)
        .in('status', ['live', 'paused', 'completed'])
        .gte('session_date', today)
        .order('session_date', { ascending: false })
        .order('start_time', { ascending: false })
        .limit(1);

    // Priorité à une séance en cours ; sinon la dernière séance terminée du jour
    const all = data || [];
    currentSession = all.find(s => s.status === 'live')
                  || all.find(s => s.status === 'paused')
                  || all[0] || null;

    renderSessionState();
    tickChrono();
}

/* ---------------- Présences ---------------- */

async function loadAttendance() {
    if (!CLUB_ID || !currentSession) return;

    const { data: atts } = await supabaseClient.from('session_attendances')
        .select('*')
        .eq('session_id', currentSession.id)
        .order('created_at', { ascending: false });

    const list = atts || [];

    // Compteur animé
    const countEl = document.getElementById('presentCount');
    if (list.length !== lastPresentCount) {
        countEl.textContent = list.length;
        if (lastPresentCount >= 0 && list.length > lastPresentCount) {
            countEl.classList.remove('count-bump');
            void countEl.offsetWidth;
            countEl.classList.add('count-bump');
        }
        lastPresentCount = list.length;
    }

    // Dernier adhérent pointé
    if (!list.length) return;
    const last = list[0];

    const [memberRes, statusRes, monthRes] = await Promise.all([
        supabaseClient.from('members')
            .select('first_name, last_name, photo_url').eq('id', last.member_id).maybeSingle(),
        supabaseClient.from('member_subscription_status')
            .select('is_active').eq('member_id', last.member_id).maybeSingle(),
        supabaseClient.from('attendance')
            .select('id', { count: 'exact', head: true })
            .eq('member_id', last.member_id)
            .eq('month', new Date().toISOString().slice(0, 7))
    ]);

    const m = memberRes.data;
    document.getElementById('attPhoto').src = m?.photo_url || 'logo.png';
    document.getElementById('attName').textContent = m ? `${m.last_name} ${m.first_name}` : last.member_id;
    document.getElementById('attId').textContent = last.member_id;
    document.getElementById('attTime').textContent = String(last.check_in_time || '').slice(0, 5);
    document.getElementById('attMonth').textContent = `حضور هذا الشهر : ${monthRes.count ?? '—'}`;

    const badge = document.getElementById('attSub');
    const active = statusRes.data?.is_active;
    badge.textContent = active ? 'الاشتراك نشط' : 'منتهي';
    badge.className = 'sub-badge ' + (active ? 'ok' : 'ko');

    const card = document.getElementById('attendeeCard');
    card.classList.remove('hidden');
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';

    // Liste des dernières inscriptions (5 max)
    document.getElementById('recentList').innerHTML =
        list.slice(0, 5).map(a => `
            <li>
                <span>${a.member_id}</span>
                <span class="dim">${String(a.check_in_time || '').slice(0, 5)}</span>
            </li>`).join('');
}

/* ---------------- Panneaux latéraux ---------------- */

async function loadSidePanels() {
    if (!CLUB_ID) return;
    const today = new Date().toISOString().slice(0, 10);

    // Prochaines séances via vue upcoming_sessions si dispo, sinon sessions
    const { data: upcoming } = await supabaseClient.from('upcoming_sessions')
        .select('*')
        .eq('club_id', CLUB_ID)
        .gte('session_date', today)
        .order('session_date')
        .limit(3);

    document.getElementById('upcomingList').innerHTML = (upcoming || []).map(s => `
        <li>
            <span>${s.group_type || ''}</span>
            <span class="dim">${fmtShortDate(s.session_date)} · ${String(s.start_time || '').slice(0, 5)}</span>
        </li>`).join('') || '<li class="empty">لا توجد حصص قادمة</li>';

    // Prochain événement
    const { data: events } = await supabaseClient.from('events')
        .select('title, event_date, event_time, lieu')
        .eq('club_id', CLUB_ID)
        .gte('event_date', today)
        .order('event_date')
        .limit(1);

    document.getElementById('eventList').innerHTML = (events || []).map(e => `
        <li>
            <span>${e.title}</span>
            <span class="dim">${fmtShortDate(e.event_date)}${e.lieu ? ' · ' + e.lieu : ''}</span>
        </li>`).join('') || '<li class="empty">لا يوجد حدث قادم</li>';
}

function fmtShortDate(d) {
    if (!d) return '';
    return new Date(d + 'T00:00:00').toLocaleDateString('ar-DZ', { day:'numeric', month:'numeric' });
}

/* ---------------- Temps réel + fallback polling ---------------- */

function subscribeRealtime() {
    if (!CLUB_ID) return;
    supabaseClient.channel('tv-' + CLUB_ID)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'sessions', filter: `club_id=eq.${CLUB_ID}` },
            () => { loadCurrentSession(); loadSidePanels(); })
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'session_attendances', filter: `club_id=eq.${CLUB_ID}` },
            () => { loadCurrentSession(); loadAttendance(); })
        .subscribe();
}

function startPollingFallback() {
    setInterval(() => { loadCurrentSession(); }, 15000);
    setInterval(() => { loadAttendance(); loadSidePanels(); }, 20000);
}

/* ---------------- Init ---------------- */

(async function initTv() {
    await loadClub();
    await loadCurrentSession();
    await loadAttendance();
    await loadSidePanels();
    subscribeRealtime();
    startPollingFallback();
})();
