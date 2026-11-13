import { createClient } from '@supabase/supabase-js';
import { DEMO_ANALYSIS_FALLBACK } from './data/demoAnalysisFallback.js';

const API_URL = (import.meta.env.DEV ? '/api' : (import.meta.env.VITE_API_URL || window.RELAY_API_URL || '/api')).replace(/\/$/, '');
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const SUPABASE_PUBLISHABLE_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim();
const SUPABASE_BUCKET = 'relay-files';
let supabaseBrowser = null;
function getSupabaseBrowserClient() {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Uploads are unavailable because the Supabase browser URL or publishable key is not configured.');
  }
  if (!supabaseBrowser) {
    try {
      supabaseBrowser = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    } catch {
      throw new Error('Uploads are unavailable because the Supabase browser configuration is invalid.');
    }
  }
  return supabaseBrowser;
}
const TOKEN_KEY = 'relayToken';
const state = { mode: 'real', token: localStorage.getItem(TOKEN_KEY), user: null, projects: [], selectedProjectId: '', sources: [], findings: [], handovers: [], selectedHandoverId: '', handoverError: '', handoverActionError: '', handoverLoading: false, handoverBusy: false, handoverDownloading: false, analysisJob: null, analysisJobError: '', analysisJobDiagnostic: null, analysisStarting: false, analysisAdvancing: false, errors: { projects: '', sources: '', findings: '' }, authMode: 'login', busy: false, reviewBusy: false, reviewFilter: 'all', sourceUploadBusy: false };
let authGeneration = 0;
let handoverRequest = 0;
const analysisRunners = new Map();
let analysisElapsedTimer = null;
const categories = ['All', 'Decision', 'Completed Work', 'Pending Tasks', 'Responsibilities', 'Blockers', 'Dependencies', 'Risks', 'Next Actions', 'Unresolved Questions'];
let activeCat = 'All';

const DEMO_WORKSPACE = Object.freeze({
  project: {
    _id: 'demo-campus-connect', name: 'Campus Connect Demo', status: 'active',
    description: 'A student services platform connecting campus clubs, events, and peer mentoring.',
    createdAt: '2026-10-28T09:00:00.000Z',
  },
  sources: [
    { _id: 'demo-source-brief', originalName: 'product-brief.md', size: 6840, status: 'processed', createdAt: '2026-11-07T13:15:00.000Z' },
    { _id: 'demo-source-architecture', originalName: 'platform-architecture.md', size: 12400, status: 'processed', createdAt: '2026-11-06T11:40:00.000Z' },
    { _id: 'demo-source-retro', originalName: 'beta-launch-retrospective.txt', size: 9360, status: 'processed', createdAt: '2026-11-05T16:20:00.000Z' },
    { _id: 'demo-source-runbook', originalName: 'event-publishing-runbook.md', size: 7120, status: 'processed', createdAt: '2026-11-04T10:05:00.000Z' },
    { _id: 'demo-source-privacy', originalName: 'privacy-review-notes.md', size: 4590, status: 'processed', createdAt: '2026-11-03T14:30:00.000Z' },
  ],
  findings: [
    { _id: 'demo-finding-decision', category: 'Decision', title: 'Use university SSO for student sign-in', description: 'The team selected the campus identity provider so students do not need a separate Campus Connect password.', confidence: 0.96, status: 'approved', evidence: [{ sourceName: 'platform-architecture.md', section: 'Authentication', quote: 'Campus Connect will delegate authentication to the university identity provider using OIDC. We will not store student passwords.' }] },
    { _id: 'demo-finding-complete', category: 'Completed Work', title: 'Closed beta launched for three student clubs', description: 'The event directory and club profile flow were tested with the Robotics, Debate, and Outdoor clubs.', confidence: 0.92, status: 'approved', evidence: [{ sourceName: 'beta-launch-retrospective.txt', section: 'Launch summary', quote: 'The closed beta went live with three clubs on October 21. All three published at least one event during the pilot.' }] },
    { _id: 'demo-finding-task', category: 'Pending Tasks', title: 'Finish calendar export for published events', description: 'ICS export is implemented for event details, but recurring events still need a timezone review.', confidence: 0.88, status: 'pending', evidence: [{ sourceName: 'product-brief.md', section: 'Release checklist', quote: 'Before general availability, verify calendar export for recurring events and confirm campus timezone handling.' }] },
    { _id: 'demo-finding-blocker', category: 'Blockers', title: 'Email delivery is blocked by sender-domain approval', description: 'Invitation and event reminder emails cannot move to production until campus IT approves the sending domain.', confidence: 0.94, status: 'pending', evidence: [{ sourceName: 'beta-launch-retrospective.txt', section: 'Open blockers', quote: 'Production email remains paused while IT reviews the campus-connect.edu sender configuration.' }] },
    { _id: 'demo-finding-responsibility', category: 'Responsibilities', title: 'Maya owns event publishing and moderation', description: 'Maya Patel maintains the publishing runbook and coordinates the club moderator pilot.', confidence: 0.86, status: 'needs_clarification', evidence: [{ sourceName: 'event-publishing-runbook.md', section: 'Ownership', quote: 'Maya coordinates moderator onboarding and owns updates to this publishing runbook.' }] },
    { _id: 'demo-finding-risk', category: 'Risks', title: 'Unreviewed event descriptions may expose personal details', description: 'The beta moderation checklist does not yet identify what student contact details must be removed before publication.', confidence: 0.82, status: 'pending', evidence: [{ sourceName: 'privacy-review-notes.md', section: 'Open questions', quote: 'Confirm whether phone numbers and personal email addresses should be blocked from public event descriptions.' }] },
    { _id: 'demo-finding-dependency', category: 'Dependencies', title: 'Production launch depends on campus email approval', description: 'Invitation emails and passwordless sign-in notices depend on approval of the sender domain.', confidence: 0.90, status: 'pending', evidence: [{ sourceName: 'privacy-review-notes.md', section: 'Launch dependencies', quote: 'Campus IT approval is required before the production sender domain can be enabled.' }] },
    { _id: 'demo-finding-next', category: 'Next Actions', title: 'Run an accessibility review with student volunteers', description: 'Schedule a keyboard and screen-reader review before opening registration to all students.', confidence: 0.89, status: 'approved', evidence: [{ sourceName: 'product-brief.md', section: 'Launch plan', quote: 'Invite at least five students to complete the key sign-up and event-discovery flows using keyboard-only navigation.' }] },
    { _id: 'demo-finding-question', category: 'Unresolved Questions', title: 'Who approves club moderator access after handover?', description: 'The runbook describes moderator responsibilities but does not identify the long-term approver.', confidence: 0.77, status: 'needs_clarification', evidence: [{ sourceName: 'event-publishing-runbook.md', section: 'Moderator access', quote: 'Moderator access is granted by the project team during beta. Confirm the owner for ongoing approvals.' }] },
  ],
});

const byId = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined && text !== null) el.textContent = String(text);
  if (className) el.className = className;
  return el;
};
const clear = (el) => el?.replaceChildren();

async function api(path, options = {}) {
  if (state.mode === 'demo') throw new Error('Demo mode does not send requests to the RELAY API.');
  const method = (options.method || 'GET').toUpperCase();
  const traceAnalysisAdvance = method === 'POST' && /^\/analysis-jobs\/[^/]+\/advance$/.test(path);
  const diagnosticPath = '/api/analysis-jobs/:jobId/advance';
  const diagnostic = (status, errorType) => {
    if (!traceAnalysisAdvance) return null;
    const details = { method, path: diagnosticPath, status: status ?? 'No HTTP response', errorType };
    console.info('[RELAY ANALYSIS REQUEST]', details);
    return details;
  };
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let response;
  try { response = await fetch(`${API_URL}${path}`, { ...options, headers }); }
  catch (error) {
    const requestError = new Error('Cannot reach the RELAY API. Check that the backend is running.');
    requestError.diagnostic = diagnostic(null, error instanceof TypeError ? 'TypeError' : 'FetchError');
    throw requestError;
  }
  let data = {};
  try { data = await response.json(); }
  catch { diagnostic(response.status, 'InvalidJSON'); }
  if (!response.ok) {
    const requestDiagnostic = diagnostic(response.status, 'HTTPError');
    if (response.status === 401 && state.token) expireSession();
    const error = new Error(data.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.diagnostic = requestDiagnostic;
    throw error;
  }
  diagnostic(response.status, 'none');
  return data;
}

function toast(message, kind = 'success') {
  const el = byId('toast');
  if (!el) return;
  byId('toastMsg').textContent = message;
  const icon = el.querySelector('[data-lucide]');
  if (icon) icon.setAttribute('data-lucide', kind === 'error' ? 'circle-alert' : 'check-circle');
  el.classList.remove('hidden');
  el.classList.add('flex');
  if (window.lucide) window.lucide.createIcons();
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => { el.classList.add('hidden'); el.classList.remove('flex'); }, 3500);
}

function setStatus(container, message, kind = 'info') {
  if (!container) return;
  clear(container);
  if (kind === 'loading') {
    const panel = node('div', undefined, 'col-span-full w-full py-5');
    panel.setAttribute('role', 'status'); panel.setAttribute('aria-busy', 'true');
    panel.append(node('p', message, 'text-center text-xs text-white/45 mb-4'));
    const rows = node('div', undefined, 'grid grid-cols-1 md:grid-cols-2 gap-3 animate-pulse');
    for (let index = 0; index < 4; index += 1) {
      const card = node('div', undefined, 'glass rounded-2xl p-4 space-y-3');
      card.append(node('div', undefined, 'h-3 w-1/3 rounded bg-white/10'), node('div', undefined, 'h-4 w-2/3 rounded bg-white/10'), node('div', undefined, 'h-3 w-full rounded bg-white/[0.06]'));
      rows.append(card);
    }
    panel.append(rows); container.append(panel); return;
  }
  const panel = node('div', undefined, 'col-span-full text-center py-8');
  const icon = node('i', undefined, `w-5 h-5 mx-auto mb-3 ${kind === 'error' ? 'text-red-300' : 'text-white/30'}`);
  icon.setAttribute('data-lucide', kind === 'error' ? 'circle-alert' : 'inbox');
  panel.append(icon, node('p', message, `text-sm ${kind === 'error' ? 'text-red-300' : 'text-white/45'}`));
  container.append(panel);
  if (window.lucide) window.lucide.createIcons();
}

function showApp() {
  byId('authOverlay').classList.add('hidden');
  byId('app').classList.remove('hidden');
  byId('userName').textContent = state.user?.name || state.user?.email || 'User';
  const avatar = byId('userAvatar');
  if (avatar) { avatar.removeAttribute('src'); avatar.textContent = (state.user?.name || state.user?.email || 'U').trim().slice(0, 1).toUpperCase(); avatar.className = 'w-8 h-8 rounded-full bg-violet-600 text-white grid place-items-center text-sm font-semibold'; }
  byId('greetName').textContent = state.user?.name?.split(/\s+/)[0] || 'there';
  byId('settingsName').textContent = state.user?.name || 'User';
  byId('settingsEmail').textContent = state.user?.email || '';
  byId('settingsAvatar').textContent = (state.user?.name || state.user?.email || 'U').trim().slice(0, 1).toUpperCase();
  byId('settingsNameInput').value = state.user?.name || '';
  byId('settingsEmailInput').value = state.user?.email || '';
  byId('demoBanner')?.classList.toggle('hidden', state.mode !== 'demo');
  byId('demoExitButton')?.classList.toggle('hidden', state.mode !== 'demo');
  const demoOffset = state.mode === 'demo' ? '2.5rem' : '0px';
  byId('sidebar').style.top = demoOffset;
  document.querySelector('header').style.top = demoOffset;
  renderAll();
}

function expireSession() {
  state.mode = 'real';
  state.token = null;
  state.user = null;
  state.projects = [];
  state.selectedProjectId = '';
  state.sources = [];
  state.findings = [];
  state.handovers = [];
  state.analysisJob = null;
  state.analysisJobError = '';
  state.errors = { projects: '', sources: '', findings: '' };
  localStorage.removeItem(TOKEN_KEY);
  byId('app').classList.add('hidden');
  byId('authOverlay').classList.remove('hidden');
}

function enterDemo() {
  authGeneration += 1;
  state.mode = 'demo';
  state.token = null;
  state.user = { name: 'Campus Connect Demo', email: 'demo@campusconnect.example' };
  state.projects = [{ ...DEMO_WORKSPACE.project }];
  state.selectedProjectId = DEMO_WORKSPACE.project._id;
  state.sources = structuredClone(DEMO_WORKSPACE.sources);
  state.findings = structuredClone(DEMO_WORKSPACE.findings);
  state.handovers = [];
  state.analysisJob = null;
  state.analysisJobError = '';
  state.errors = { projects: '', sources: '', findings: '' };
  if (state.authMode !== 'login') toggleAuthMode();
  showApp();
  refreshProjectControls();
  toast('DEMO DATA · sample workspace only. No API requests are sent.');
}

function exitDemo() {
  authGeneration += 1;
  state.mode = 'real';
  state.token = localStorage.getItem(TOKEN_KEY);
  state.projects = [];
  state.selectedProjectId = '';
  state.sources = [];
  state.findings = [];
  state.handovers = [];
  state.analysisJob = null;
  state.analysisJobError = '';
  state.errors = { projects: '', sources: '', findings: '' };
  byId('app').classList.add('hidden');
  byId('authOverlay').classList.remove('hidden');
  byId('authEmail').focus();
  restoreSession();
}

function toggleAuthMode() {
  state.authMode = state.authMode === 'login' ? 'register' : 'login';
  const registering = state.authMode === 'register';
  byId('registerNameField').classList.toggle('hidden', !registering);
  byId('authName').required = registering;
  const passwordInput = byId('authPass');
  passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
  if (registering) {
    passwordInput.minLength = 8;
    passwordInput.maxLength = 128;
  } else {
    passwordInput.removeAttribute('minlength');
    passwordInput.removeAttribute('maxlength');
  }
  byId('loginBtn').firstChild.textContent = registering ? 'Create account ' : 'Sign in ';
  byId('authSwitchText').textContent = registering ? 'Already have an account?' : 'No account?';
  byId('authSwitch').textContent = registering ? 'Sign in' : 'Create account';
  byId('authError').classList.add('hidden');
}

async function login(event) {
  event.preventDefault();
  if (state.busy) return;
  const errorEl = byId('authError');
  errorEl.classList.add('hidden');
  const registering = state.authMode === 'register';
  const payload = { email: byId('authEmail').value.trim().toLowerCase(), password: byId('authPass').value };
  if (registering) payload.name = byId('authName').value.trim();
  if (registering && payload.password.length < 8) {
    errorEl.textContent = 'Use a password with at least 8 characters.';
    errorEl.classList.remove('hidden');
    return;
  }
  state.busy = true;
  const attempt = ++authGeneration;
  const button = byId('loginBtn');
  button.disabled = true;
  button.textContent = registering ? 'Creating account…' : 'Signing in…';
  try {
    const data = await api(`/auth/${registering ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(payload) });
    if (attempt !== authGeneration || state.mode !== 'real') return;
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem(TOKEN_KEY, state.token);
    showApp();
    toast(registering ? 'Account created and signed in' : 'Signed in');
  } catch (error) {
    errorEl.textContent = error.status === 409
      ? 'An account with this email already exists. Switch to sign in.'
      : error.status === 400
        ? error.message
        : error.status >= 500
          ? `RELAY could not complete ${registering ? 'registration' : 'sign in'} right now. Please try again shortly.`
          : error.message;
    errorEl.classList.remove('hidden');
  } finally {
    state.busy = false;
    button.disabled = false;
    button.textContent = registering ? 'Create account' : 'Sign in';
  }
}

function logout() { expireSession(); }
function togglePass() {
  const input = byId('authPass');
  input.type = input.type === 'password' ? 'text' : 'password';
}
function toggleSidebar() { byId('sidebar').classList.toggle('-translate-x-full'); }

async function loadProjects() {
  if (state.mode === 'demo') {
    renderProjects(); renderProjectSelector(); renderDashboard();
    await loadProjectData();
    return;
  }
  setStatus(byId('projectsGrid'), 'Loading your projects…', 'loading');
  const select = byId('projectSelect');
  select.replaceChildren(new Option('Loading projects…', ''));
  try {
    const data = await api('/projects');
    state.errors.projects = '';
    state.projects = data.projects || [];
    refreshProjectControls();
    renderProjects();
    renderProjectSelector();
    renderDashboard();
    if (!state.projects.length) {
      state.selectedProjectId = '';
      state.sources = [];
      state.findings = [];
      state.errors.sources = '';
      state.errors.findings = '';
      renderSources(); renderFindings(); renderReview();
      return;
    }
    if (!state.projects.some((project) => project._id === state.selectedProjectId)) state.selectedProjectId = state.projects[0]._id;
    select.value = state.selectedProjectId;
    await loadProjectData();
  } catch (error) {
    state.errors.projects = error.message;
    state.errors.sources = error.message;
    state.errors.findings = error.message;
    state.projects = [];
    refreshProjectControls();
    state.sources = [];
    state.findings = [];
    renderProjectSelector(error.message);
    setStatus(byId('projectsGrid'), `Could not load projects: ${error.message}`, 'error');
    setStatus(byId('sourcesList'), 'Could not load sources because the project list failed.', 'error');
    setStatus(byId('findingsGrid'), 'Could not load findings because the project list failed.', 'error');
    setStatus(byId('reviewList'), 'Could not load the review queue because the project list failed.', 'error');
    renderDashboard();
  }
}

function renderProjectSelector(errorMessage = '') {
  const select = byId('projectSelect');
  clear(select);
  if (errorMessage) { select.add(new Option('Project list unavailable', '')); select.disabled = true; return; }
  select.disabled = false;
  if (!state.projects.length) {
    select.add(new Option('No projects yet', ''));
    return;
  }
  select.add(new Option('Select a project…', ''));
  state.projects.forEach((project) => select.add(new Option(project.name, project._id)));
  select.value = state.selectedProjectId;
}

async function selectProject(projectId) {
  handoverRequest += 1;
  state.selectedProjectId = projectId;
  state.handovers = [];
  state.selectedHandoverId = '';
  state.handoverError = '';
  state.handoverActionError = '';
  state.analysisJob = null;
  state.analysisJobError = '';
  renderAnalysisJob();
  const project = state.projects.find((item) => item._id === projectId);
  if (project) {
    byId('detailTitle').textContent = project.name;
    byId('detailDesc').textContent = project.description || 'Project handover';
  }
  byId('projectDetail')?.classList.toggle('hidden', !projectId);
  refreshProjectControls();
  renderDashboard();
  await loadProjectData();
  if (projectId) switchProjectTab('overview');
}

async function loadProjectData() {
  if (!state.selectedProjectId) {
    state.sources = [];
    state.findings = [];
    state.errors.sources = '';
    state.errors.findings = '';
    state.analysisJob = null;
    state.analysisJobError = '';
    renderAnalysisJob();
    renderSources(); renderFindings(); renderReview();
    return;
  }
  if (state.mode === 'demo') {
    state.errors.sources = '';
    state.errors.findings = '';
    state.analysisJob = null;
    state.analysisJobError = '';
    renderAnalysisJob();
    renderSources(); renderFindings(); renderReview(); renderProjects(); renderDashboard();
    return;
  }
  setStatus(byId('sourcesList'), 'Loading sources…', 'loading');
  setStatus(byId('findingsGrid'), 'Loading findings…', 'loading');
  setStatus(byId('reviewList'), 'Loading review queue…', 'loading');
  const id = encodeURIComponent(state.selectedProjectId);
  const results = await Promise.allSettled([
    api(`/projects/${id}/sources`),
    api(`/projects/${id}/findings`),
  ]);
  if (results[0].status === 'fulfilled') { state.sources = results[0].value.sources || []; state.errors.sources = ''; }
  else { state.sources = []; state.errors.sources = results[0].reason.message; }
  if (results[1].status === 'fulfilled') { state.findings = results[1].value.findings || []; state.errors.findings = ''; }
  else { state.findings = []; state.errors.findings = results[1].reason.message; }
  refreshProjectControls();
  renderSources(); renderFindings(); renderReview(); renderProjects();
  renderDashboard();
  await loadAnalysisJob({ resume: true });
}

function renderProjects() {
  const container = byId('projectsGrid');
  if (!container) return;
  clear(container);
  if (!state.projects.length) { setStatus(container, 'No projects yet. Create a project to start a handover.'); return; }
  const query = (byId('projectSearch')?.value || '').trim().toLowerCase();
  const statusFilter = byId('projectFilter')?.value || 'all';
  const visible = state.projects.filter((project) => (!query || `${project.name} ${project.description || ''}`.toLowerCase().includes(query)) && (statusFilter === 'all' || project.status === statusFilter.toLowerCase()));
  if (!visible.length) { setStatus(container, 'No projects match your search.'); return; }
  visible.forEach((project) => {
    const card = node('button', undefined, 'glass rounded-2xl p-5 card-hover cursor-pointer text-left w-full');
    card.type = 'button';
    card.addEventListener('click', () => { selectProject(project._id); navigate('sources'); });
    const top = node('div', undefined, 'flex items-center justify-between');
    const badge = node('span', String(project.status || 'active').toUpperCase(), 'text-[11px] font-mono tracking-widest px-2.5 py-1 rounded-full bg-emerald-500 text-white');
    const updated = node('span', project.updatedAt ? new Date(project.updatedAt).toLocaleDateString() : '', 'text-xs text-white/40');
    const role = state.mode === 'demo' ? 'DEMO' : String(project.owner) === String(state.user?.id) ? 'OWNER' : ((project.members || []).find((member) => String(member.user?._id || member.user) === String(state.user?.id))?.role || 'MEMBER').toUpperCase();
    top.append(badge, node('span', role, 'text-[10px] font-mono tracking-wider text-violet-200 bg-violet-500/15 px-2 py-1 rounded-full'), updated);
    const title = node('h3', project.name, 'text-white font-semibold mt-3');
    const description = node('p', project.description || 'No description provided.', 'text-white/40 text-sm mt-1 line-clamp-2');
    card.append(top, title, description, node('p', 'Open project →', 'mt-4 text-xs text-violet-400'));
    container.append(card);
  });
}

async function openCreateProject() {
  const name = window.prompt('Project name:');
  if (!name?.trim()) return;
  if (state.mode === 'demo') {
    const project = { _id: `demo-project-${Date.now()}`, name: name.trim(), description: 'Created in the local demo session; this project is not saved.', status: 'active', createdAt: new Date().toISOString() };
    state.projects.push(project);
    state.selectedProjectId = project._id;
    state.sources = [];
    state.findings = [];
    renderProjectSelector();
    renderProjects(); renderSources(); renderFindings(); renderReview(); renderDashboard();
    toast('DEMO DATA · project exists only in this browser session.');
    return;
  }
  try {
    const data = await api('/projects', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    state.projects.unshift(data.project);
    state.selectedProjectId = data.project._id;
    renderProjects(); renderProjectSelector();
    byId('projectSelect').value = state.selectedProjectId;
    await loadProjectData();
    toast('Project created');
  } catch (error) { toast(`Project creation failed: ${error.message}`, 'error'); }
}

function statusLabel(status) {
  return ({ processed: 'Processed', uploaded: 'Uploaded', processing: 'Processing', failed: 'Failed', pending: 'Pending', approved: 'Approved', rejected: 'Rejected', needs_clarification: 'Needs Clarification' })[status] || status || 'Unknown';
}

function renderSources() {
  const container = byId('sourcesList');
  if (!container) return;
  refreshProjectControls();
  clear(container);
  if (state.errors.sources) { setStatus(container, `Could not load sources: ${state.errors.sources}`, 'error'); return; }
  if (!state.selectedProjectId) { setStatus(container, 'Select or create a project before uploading sources.'); return; }
  if (!state.sources.length) { setStatus(container, 'No sources in this project yet. Upload a document to get started.'); return; }
  const filter = byId('sourceFilter')?.value || 'all';
  const sources = state.sources.filter((source) => filter === 'all' || statusLabel(source.status) === filter);
  if (!sources.length) { setStatus(container, state.sources.length ? 'No sources match this status.' : 'No sources in this project yet. Upload a document to get started.'); return; }
  sources.forEach((source) => {
    const card = node('div', undefined, 'glass rounded-2xl p-4 flex gap-4');
    const ext = source.originalName?.split('.').pop()?.toUpperCase() || 'FILE';
    card.append(node('div', ext, 'w-11 h-11 rounded-xl bg-violet-500/20 text-violet-400 flex items-center justify-center shrink-0 font-mono text-xs font-bold'));
    const content = node('div', undefined, 'flex-1 min-w-0');
    content.append(node('p', source.originalName, 'text-white text-sm font-medium truncate'));
    content.append(node('p', `${statusLabel(source.status)}${source.size ? ` · ${(source.size / 1024).toFixed(1)} KB` : ''}`, 'text-white/40 text-xs mt-1'));
    if (source.error) content.append(node('p', source.error, 'text-red-300 text-xs mt-2'));
    card.append(content);
    container.append(card);
  });
}

async function handleUpload(files) {
  if (!files?.length) return;
  if (state.mode === 'demo') { toast('DEMO DATA · uploads are disabled. Exit demo to upload a real file.', 'error'); return; }
  if (!canManageCurrentProject()) { toast('Only project owners and editors can upload sources.', 'error'); return; }
  if (!state.selectedProjectId) { toast('Select or create a project before uploading.', 'error'); return; }
  if (state.sourceUploadBusy) { toast('A source upload is already in progress.', 'error'); return; }
  let storageClient;
  try { storageClient = getSupabaseBrowserClient(); }
  catch (error) { setSourceUploadStatus(error.message, 'error'); toast(error.message, 'error'); return; }
  const projectId = encodeURIComponent(state.selectedProjectId);
  const batch = Array.from(files);
  const fileInput = document.querySelector('#view-sources input[type="file"]');
  state.sourceUploadBusy = true;
  if (fileInput) fileInput.disabled = true;
  try {
    for (const [index, file] of batch.entries()) {
      try {
        const fileType = sourceUploadMimeType(file);
        if (file.size < 1 || file.size > 15 * 1024 * 1024) throw new Error('Choose a file between 1 byte and 15 MiB.');
        if (!fileType) throw new Error('Only PDF, DOCX, TXT and MD files are accepted.');
        setSourceUploadStatus(`Preparing secure upload for ${file.name} (${index + 1} of ${batch.length})…`);
        const intent = await api(`/projects/${projectId}/sources/upload-intent`, {
          method: 'POST',
          body: JSON.stringify({ originalName: file.name, mimeType: fileType, size: file.size }),
        });
        if (!intent?.source?._id || typeof intent.uploadUrl !== 'string') throw new Error('The server returned an incomplete upload authorization.');

        const signedUpload = parseSignedUploadUrl(intent.uploadUrl);
        setSourceUploadStatus(`Uploading ${file.name} directly to private storage (${index + 1} of ${batch.length})…`);
        const uploaded = await storageClient.storage.from(signedUpload.bucket).uploadToSignedUrl(
          signedUpload.path,
          signedUpload.token,
          file,
          { contentType: fileType, upsert: false },
        );
        if (uploaded.error) throw new Error('Private storage could not accept this file. Check the bucket CORS and upload settings.');

        setSourceUploadStatus(`Verifying and extracting ${file.name} (${index + 1} of ${batch.length})…`);
        await api(`/sources/${encodeURIComponent(intent.source._id)}/complete`, { method: 'POST' });

        if (state.mode === 'real' && state.selectedProjectId === decodeURIComponent(projectId)) {
          setSourceUploadStatus(`Refreshing sources after ${file.name}…`);
          try {
            const refreshed = await api(`/projects/${projectId}/sources`);
            state.sources = refreshed.sources || [];
            state.errors.sources = '';
            renderSources();
          } catch (refreshError) {
            state.errors.sources = refreshError.message;
            renderSources();
            setSourceUploadStatus(`${file.name} was processed, but the source list could not be refreshed: ${refreshError.message}`, 'error');
            toast('Source processed, but the list could not be refreshed.', 'error');
            continue;
          }
        }
        setSourceUploadStatus(`${file.name} uploaded and processed.`, 'success');
        toast(`${file.name} uploaded and processed`);
      } catch (error) {
        setSourceUploadStatus(`Upload failed for ${file.name}: ${error.message}`, 'error');
        toast(`Upload failed for ${file.name}: ${error.message}`, 'error');
      }
    }
  } finally {
    state.sourceUploadBusy = false;
    if (fileInput) {
      fileInput.value = '';
      fileInput.disabled = !canManageCurrentProject();
    }
  }
}

function sourceUploadMimeType(file) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const allowed = {
    pdf: ['application/pdf', 'application/x-pdf', 'application/octet-stream'],
    docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream'],
    txt: ['text/plain', 'application/octet-stream'],
    md: ['text/markdown', 'text/x-markdown', 'text/plain', 'application/octet-stream'],
  }[extension];
  if (!allowed) return '';
  return allowed.includes(file.type) ? file.type : (!file.type ? allowed[0] : '');
}

function parseSignedUploadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The server returned an invalid upload authorization.'); }
  let expectedOrigin;
  try { expectedOrigin = new URL(SUPABASE_URL).origin; } catch { throw new Error('Supabase browser configuration is invalid.'); }
  const marker = '/object/upload/sign/';
  const markerIndex = url.pathname.indexOf(marker);
  if (url.origin !== expectedOrigin || markerIndex < 0) throw new Error('The server upload authorization does not match the configured Supabase project.');
  const bucketAndKey = url.pathname.slice(markerIndex + marker.length);
  const separator = bucketAndKey.indexOf('/');
  const bucket = separator < 0 ? '' : decodeURIComponent(bucketAndKey.slice(0, separator));
  const path = separator < 0 ? '' : decodeURIComponent(bucketAndKey.slice(separator + 1));
  const token = url.searchParams.get('token');
  if (bucket !== SUPABASE_BUCKET || !path || !token) throw new Error('The server upload authorization is incomplete.');
  return { bucket, path, token };
}

function setSourceUploadStatus(message, kind = 'info') {
  const status = byId('sourceUploadStatus');
  if (!status) return;
  status.textContent = message;
  status.className = `text-xs mt-1 ${kind === 'error' ? 'text-red-300' : kind === 'success' ? 'text-emerald-300' : 'text-white/45'}`;
}

function findingStatus(status) { return statusLabel(status); }
function renderFindings() {
  const container = byId('findingsGrid');
  if (!container) return;
  clear(container);
  if (state.errors.findings) { setStatus(container, `Could not load findings: ${state.errors.findings}`, 'error'); return; }
  if (!state.selectedProjectId) { setStatus(container, 'Select or create a project to view findings.'); return; }
  if (!state.findings.length) { setStatus(container, 'No findings yet. Upload a processed source, then run analysis.'); return; }
  const query = (byId('findingSearch')?.value || '').trim().toLowerCase();
  const filter = byId('findingStatus')?.value || 'all';
  const items = state.findings.filter((finding) => {
    const evidenceText = (finding.evidence || []).map((evidence) => `${evidence.sourceName || evidence.source?.originalName || ''} ${evidence.quote || ''}`).join(' ');
    const matchesQuery = !query || `${finding.title} ${finding.description} ${evidenceText}`.toLowerCase().includes(query);
    const matchesStatus = filter === 'all' || (filter === 'Verified' ? finding.status === 'approved' : findingStatus(finding.status) === filter);
    const matchesCategory = activeCat === 'All' || finding.category === activeCat;
    return matchesQuery && matchesStatus && matchesCategory;
  });
  if (!items.length) { setStatus(container, 'No findings match these filters.'); return; }
  items.forEach((finding) => {
    const card = node('article', undefined, 'glass rounded-2xl p-4 card-hover');
    const top = node('div', undefined, 'flex items-start justify-between gap-2');
    top.append(node('span', finding.category, 'text-[11px] font-mono tracking-widest px-2 py-1 rounded-full border bg-violet-500/15 text-violet-300 border-violet-500/30'));
    top.append(node('span', findingStatus(finding.status), 'text-xs px-2 py-1 rounded-full bg-white/10 text-white/70'));
    card.append(top, node('h3', finding.title, 'text-white font-semibold mt-3 leading-tight'), node('p', finding.description, 'text-white/50 text-sm mt-1 leading-relaxed'));
    const confidence = Math.round(Math.max(0, Math.min(1, Number(finding.confidence) || 0)) * 100);
    card.append(node('p', `${confidence}% confidence · ${(finding.evidence || []).length} evidence item(s)`, 'text-xs text-white/50 mt-3'));
    (finding.evidence || []).forEach((evidence) => {
      const sourceName = evidence.sourceName || evidence.source?.originalName || 'Source';
      const quote = node('blockquote', `“${evidence.quote || 'No supporting quote returned.'}”`, 'mt-3 border-l-2 border-violet-500/50 pl-3 text-xs text-white/60');
      quote.title = `${sourceName}${evidence.section ? ` · ${evidence.section}` : ''}`;
      card.append(node('p', sourceName, 'mt-3 text-xs text-violet-300'), quote);
    });
    const evidenceButton = node('button', 'View evidence', 'mt-4 rounded-full bg-white/10 px-4 py-2 text-xs text-white hover:bg-white/15 transition');
    evidenceButton.type = 'button';
    evidenceButton.addEventListener('click', () => openEvidence(finding._id));
    card.append(evidenceButton);
    container.append(card);
  });
}

function renderReview() {
  const container = byId('reviewList');
  if (!container) return;
  clear(container);
  if (state.errors.findings) { setStatus(container, `Could not load findings: ${state.errors.findings}`, 'error'); return; }
  if (!state.selectedProjectId) { setStatus(container, 'Select a project to view its review queue.'); return; }
  const filtered = state.findings.filter((finding) => state.reviewFilter === 'all' || finding.status === state.reviewFilter);
  if (!filtered.length) { setStatus(container, state.findings.length ? 'No findings in this review filter.' : 'No findings are waiting for review.'); return; }
  document.querySelectorAll('.rfilter').forEach((button) => {
    const active = button.dataset.rfilter === state.reviewFilter;
    button.classList.toggle('bg-white', active); button.classList.toggle('text-[#060A16]', active);
    button.classList.toggle('bg-white/10', !active); button.classList.toggle('text-white/70', !active);
  });
  filtered.forEach((finding) => {
    const row = node('article', undefined, 'glass rounded-2xl p-4');
    row.append(node('p', `${finding.category} · ${findingStatus(finding.status)}`, 'text-xs text-violet-300'), node('h3', finding.title, 'text-white font-semibold mt-2'), node('p', finding.description, 'text-white/50 text-sm mt-1'));
    (finding.evidence || []).forEach((item) => {
      const evidence = node('div', undefined, 'mt-3 rounded-xl bg-white/[0.03] border border-white/5 p-3');
      evidence.append(node('span', item.verificationStatus === 'verified' ? 'VERIFIED · EXACT SOURCE MATCH' : 'UNVERIFIED · CHECK SOURCE', `text-[10px] font-mono tracking-wider ${item.verificationStatus === 'verified' ? 'text-emerald-300' : 'text-amber-300'}`));
      evidence.append(node('blockquote', item.quote || 'No supporting quote returned.', 'mt-2 border-l-2 border-violet-500/50 pl-3 text-xs text-white/60'));
      row.append(evidence);
    });
    const actions = node('div', undefined, 'mt-4 flex flex-wrap gap-2');
    if (state.mode === 'demo') {
      actions.append(node('span', 'DEMO DATA · Review actions are disabled in the sample workspace.', 'text-xs text-violet-300/75'));
    } else if (!canManageCurrentProject()) {
      actions.append(node('span', 'Read-only · Project owner or editor access is required to review findings.', 'text-xs text-white/40'));
    } else {
      if (finding.status === 'pending') {
        const approve = reviewButton('Approve', 'bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30', () => confirmApproveFinding(finding._id));
        const reject = reviewButton('Reject', 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30', () => requestFindingComment(finding._id, 'reject'));
        const clarify = reviewButton('Request clarification', 'bg-amber-500/20 text-amber-100 hover:bg-amber-500/30', () => requestFindingComment(finding._id, 'clarify'));
        actions.append(approve, reject, clarify);
      }
      if (finding.status === 'pending' || finding.status === 'needs_clarification') actions.append(reviewButton('Edit', 'bg-white/10 text-white hover:bg-white/15', () => openReviewEdit(finding._id)));
      if (finding.status === 'approved') actions.append(reviewButton('Reopen', 'bg-amber-500/20 text-amber-100 hover:bg-amber-500/30', () => requestFindingComment(finding._id, 'reopen')));
      else if (!['pending', 'needs_clarification'].includes(finding.status)) actions.append(node('span', 'This decision is final.', 'self-center text-xs text-white/35'));
    }
    const historyToggle = reviewButton('Review history', 'bg-white/5 text-white/70 hover:bg-white/10', () => toggleReviewHistory(finding._id));
    actions.append(historyToggle);
    row.append(actions);
    const historyPanel = node('div', undefined, 'hidden mt-3 rounded-xl border border-white/5 bg-[#080D1C] p-3 space-y-3');
    historyPanel.id = `review-history-${finding._id}`;
    row.append(historyPanel);
    container.append(row);
  });
}

function reviewButton(label, classes, handler) {
  const button = node('button', label, `rounded-full px-3 py-2 text-xs transition ${classes}`);
  button.type = 'button';
  button.disabled = state.reviewBusy;
  button.addEventListener('click', handler);
  return button;
}

function canManageCurrentProject() {
  if (state.mode !== 'real') return false;
  const project = state.projects.find((item) => item._id === state.selectedProjectId);
  if (!project || !state.user?.id) return false;
  if (String(project.owner) === String(state.user.id)) return true;
  return (project.members || []).some((member) => String(member.user?._id || member.user) === String(state.user.id) && member.role === 'editor');
}

function refreshProjectControls() {
  const allowed = state.mode === 'demo' || canManageCurrentProject();
  const input = document.querySelector('#view-sources input[type="file"]');
  if (input) input.disabled = !allowed || state.sourceUploadBusy;
  const uploadLabel = byId('sourceUploadLabel');
  if (uploadLabel) {
    uploadLabel.classList.toggle('opacity-40', !allowed);
    uploadLabel.classList.toggle('cursor-not-allowed', !allowed);
    uploadLabel.title = allowed ? '' : 'Owner or editor access is required to upload.';
  }
  for (const id of ['analyzeTopButton', 'analyzeFindingsButton']) {
    const button = byId(id);
    if (button) {
      button.disabled = !allowed;
      button.classList.toggle('opacity-40', !allowed);
      button.classList.toggle('cursor-not-allowed', !allowed);
      button.title = allowed ? '' : 'Owner or editor access is required to run analysis.';
    }
  }
  const note = byId('sourcePermissionNote');
  if (note) note.textContent = state.mode === 'demo' ? 'DEMO DATA · Uploads and analysis are not connected in the sample workspace.' : allowed ? 'Owners and editors can upload sources and run analysis.' : 'Read-only access · Ask the project owner to grant Editor access to upload or run analysis.';
  renderAnalysisJob();
}

async function submitReviewAction(findingId, action, payload = {}) {
  if (state.mode !== 'real' || !state.selectedProjectId) return;
  state.reviewBusy = true;
  renderReview();
  try {
    const path = action === 'edit' ? `/findings/${encodeURIComponent(findingId)}` : `/findings/${encodeURIComponent(findingId)}/${action}`;
    await api(path, { method: action === 'edit' ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    closeReviewDialogs();
    await loadProjectData();
    const successLabel = { approve: 'approved', reject: 'rejected', clarify: 'sent for clarification', edit: 'updated', reopen: 'reopened for correction' }[action];
    toast(`Finding ${successLabel} and saved`);
  } catch (error) {
    const fieldError = byId(action === 'edit' ? 'reviewEditError' : 'reviewCommentError');
    if (fieldError) { fieldError.textContent = error.message; fieldError.classList.remove('hidden'); }
    toast(`Review action failed: ${error.message}`, 'error');
  }
  finally { state.reviewBusy = false; renderReview(); }
}

function confirmApproveFinding(findingId) {
  if (window.confirm('Approve this finding? This records a permanent review decision.')) submitReviewAction(findingId, 'approve');
}

let commentFindingId = '';
let commentAction = '';
function requestFindingComment(findingId, action) {
  if (state.mode !== 'real') return;
  if (action === 'reject' && !window.confirm('Reject this finding? A reason is required and this action will be recorded in review history.')) return;
  commentFindingId = findingId; commentAction = action;
  const rejection = action === 'reject';
  const reopening = action === 'reopen';
  byId('reviewCommentTitle').textContent = rejection ? 'Reject finding' : reopening ? 'Reopen approved finding' : 'Request clarification';
  byId('reviewCommentHint').textContent = rejection ? 'A reason is required and will be recorded in review history.' : reopening ? 'Reopening returns this finding to pending. Explain the correction needed; this reason will be audited.' : 'Tell the author what needs clarification. This comment will be recorded in review history.';
  byId('reviewCommentText').value = '';
  byId('reviewCommentText').placeholder = rejection ? 'Explain why this finding is rejected…' : reopening ? 'Why does this approved finding need correction?' : 'What information should be clarified?';
  byId('reviewCommentSubmit').textContent = rejection ? 'Confirm rejection' : reopening ? 'Reopen for correction' : 'Request clarification';
  byId('reviewCommentSubmit').className = `rounded-full px-4 py-2 text-sm font-semibold text-white ${rejection ? 'bg-rose-600' : 'bg-amber-600'}`;
  byId('reviewCommentError').classList.add('hidden');
  byId('reviewCommentModal').classList.remove('hidden');
  byId('reviewCommentModal').classList.add('flex');
  byId('reviewCommentText').focus();
}

function openReviewEdit(findingId) {
  const finding = state.findings.find((item) => item._id === findingId);
  if (!finding || !canManageCurrentProject()) return;
  byId('reviewEditTitleInput').value = finding.title || '';
  byId('reviewEditCategory').value = finding.category || 'Decision';
  byId('reviewEditDescription').value = finding.description || '';
  byId('reviewEditHint').textContent = finding.status === 'needs_clarification' ? 'Saving your update returns this finding to pending review. Evidence is preserved as-is.' : 'Update the finding before approval. Evidence is preserved as-is.';
  byId('reviewEditError').classList.add('hidden');
  byId('reviewEditModal').dataset.findingId = findingId;
  byId('reviewEditModal').classList.remove('hidden');
  byId('reviewEditModal').classList.add('flex');
}

function closeReviewDialogs() {
  for (const id of ['reviewEditModal', 'reviewCommentModal']) { byId(id).classList.add('hidden'); byId(id).classList.remove('flex'); }
}

async function toggleReviewHistory(findingId) {
  const panel = byId(`review-history-${findingId}`);
  if (!panel) return;
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  clear(panel);
  if (state.mode === 'demo') { panel.append(node('p', 'DEMO DATA · Review history is not connected to a live database.', 'text-xs text-violet-200/70')); return; }
  panel.append(node('p', 'Loading saved review history…', 'text-xs text-white/45'));
  try {
    const data = await api(`/findings/${encodeURIComponent(findingId)}/review-history`);
    clear(panel);
    if (!data.history?.length) { panel.append(node('p', 'No review actions have been recorded yet.', 'text-xs text-white/45')); return; }
    data.history.forEach((entry) => {
      const item = node('div', undefined, 'border-l-2 border-violet-500/40 pl-3');
      const reviewer = entry.reviewer?.name || entry.reviewer?.email || 'Project reviewer';
      const time = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : 'Timestamp unavailable';
      item.append(node('p', `${reviewActionLabel(entry.action)} · ${reviewer}`, 'text-sm text-white/85'), node('p', time, 'text-[11px] text-white/40 mt-1'));
      if (entry.reason) item.append(node('p', `Reason: ${entry.reason}`, 'text-xs text-rose-200 mt-2 whitespace-pre-wrap'));
      if (entry.comment) item.append(node('p', `Comment: ${entry.comment}`, 'text-xs text-amber-100 mt-2 whitespace-pre-wrap'));
      if (entry.updatedValues && Object.keys(entry.updatedValues).some((key) => ['title', 'description', 'category'].includes(key))) {
        const changes = Object.keys(entry.updatedValues).filter((key) => ['title', 'description', 'category'].includes(key)).map((key) => `${key}: ${entry.previousValues?.[key] ?? '—'} → ${entry.updatedValues[key]}`).join('\n');
        item.append(node('pre', changes, 'text-[11px] text-white/50 mt-2 whitespace-pre-wrap break-words font-mono'));
      }
      panel.append(item);
    });
  } catch (error) { clear(panel); panel.append(node('p', `Could not load review history: ${error.message}`, 'text-xs text-rose-300')); }
}

function reviewActionLabel(action) {
  return ({ approved: 'Approved', rejected: 'Rejected', clarification_requested: 'Requested clarification', edited: 'Edited', returned_to_pending: 'Updated and returned to pending', reopened: 'Reopened for correction' })[action] || action;
}

function updateDemoFinding(id, status) {
  if (state.mode !== 'demo') return;
  const finding = state.findings.find((item) => item._id === id);
  if (!finding) return;
  finding.status = status;
  renderFindings(); renderReview(); renderDashboard();
  toast(`DEMO DATA · marked ${statusLabel(status).toLowerCase()} in this session only.`);
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function renderAnalysisJob() {
  const panel = byId('analysisJobStatus');
  if (!panel) return;
  clear(panel);
  panel.classList.add('hidden');
  const active = state.analysisJob;
  const statusLabels = {
    queued: 'Queued', running: 'Analyzing a source', retry_wait: 'Waiting to retry a temporary provider failure',
    completed: 'Analysis complete', failed: 'Analysis needs attention',
  };
  const busy = state.analysisStarting || state.analysisAdvancing || ['queued', 'running', 'retry_wait'].includes(active?.status);
  for (const id of ['analyzeTopButton', 'analyzeFindingsButton']) {
    const button = byId(id);
    if (!button) continue;
    const allowed = state.mode === 'demo' || canManageCurrentProject();
    button.disabled = !allowed || busy;
    const label = button.querySelector('span');
    if (label) label.textContent = active?.status === 'failed' ? 'Retry Analysis' : busy ? 'Analysis In Progress' : 'Analyze New Sources';
  }
  if (state.mode === 'demo') {
    if (analysisElapsedTimer) { window.clearInterval(analysisElapsedTimer); analysisElapsedTimer = null; }
    panel.classList.remove('hidden');
    panel.append(node('p', 'DEMO DATA · Sample findings are not generated by AI. Demo analysis actions do not call the API.', 'text-sm text-violet-200/80'));
    return;
  }
  if (state.analysisStarting && !active) {
    panel.classList.remove('hidden');
    panel.className = 'rounded-3xl border border-violet-300/20 bg-gradient-to-br from-violet-500/10 via-[#101831] to-sky-500/5 p-5 sm:p-7 shadow-2xl shadow-violet-950/20';
    const hero = node('div', undefined, 'flex items-start gap-4');
    const icon = node('div', undefined, 'grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-violet-300/20 bg-violet-400/10');
    icon.append(node('span', undefined, 'h-5 w-5 animate-spin rounded-full border-2 border-violet-200/25 border-t-violet-200'));
    hero.append(icon);
    const copy = node('div', undefined, 'min-w-0 flex-1');
    copy.append(node('p', 'Preparing your analysis', 'text-lg font-semibold tracking-tight text-white'));
    copy.append(node('p', 'RELAY is saving the job before processing begins. AI analysis and evidence verification can take several minutes.', 'mt-1 max-w-2xl text-sm leading-6 text-white/60'));
    hero.append(copy); panel.append(hero);
    panel.append(node('p', 'Keep this authenticated workspace open. Closing the page pauses browser-driven processing; returning to the project resumes the saved job.', 'mt-5 border-t border-white/10 pt-4 text-xs leading-5 text-white/45'));
    return;
  }
  if (state.analysisJobError) {
    panel.classList.remove('hidden');
    panel.className = 'rounded-3xl border border-rose-300/20 bg-rose-500/[0.06] p-5 sm:p-7';
    panel.append(node('p', `Could not load analysis status: ${state.analysisJobError}`, 'text-sm text-rose-200'));
    if (state.analysisJobDiagnostic) {
      const diagnostic = state.analysisJobDiagnostic;
      const details = node('div', undefined, 'mt-4 rounded-xl border border-rose-200/10 bg-black/10 p-3 text-xs text-rose-100/70');
      details.append(node('p', 'TEMPORARY REQUEST DIAGNOSTIC', 'mb-2 font-semibold tracking-wide text-rose-100/80'));
      details.append(node('p', `Method: ${diagnostic.method}`));
      details.append(node('p', `Endpoint: ${diagnostic.path}`));
      details.append(node('p', `HTTP status: ${diagnostic.status}`));
      details.append(node('p', `Error type: ${diagnostic.errorType}`));
      panel.append(details);
    }
    return;
  }
  if (!active) { if (analysisElapsedTimer) { window.clearInterval(analysisElapsedTimer); analysisElapsedTimer = null; } return; }
  panel.classList.remove('hidden');
  panel.className = `relative overflow-hidden rounded-3xl border p-5 sm:p-7 transition-colors ${active.status === 'failed' ? 'border-rose-300/20 bg-rose-500/[0.06]' : active.status === 'completed' ? 'border-emerald-300/20 bg-emerald-500/[0.06]' : 'border-violet-300/20 bg-gradient-to-br from-violet-500/10 via-[#101831] to-sky-500/5 shadow-2xl shadow-violet-950/20'}`;
  const total = active.sourceIds?.length || 0;
  const completed = Math.min(total, active.completedSourceCount || 0);
  const source = state.sources.find((item) => String(item._id) === String(active.currentSource));
  const elapsed = active.startedAt ? Date.now() - new Date(active.startedAt).getTime() : active.elapsedMs || 0;
  const hero = node('div', undefined, 'flex items-start gap-4');
  const icon = node('div', undefined, `grid h-12 w-12 shrink-0 place-items-center rounded-2xl border ${active.status === 'completed' ? 'border-emerald-300/20 bg-emerald-400/10' : active.status === 'failed' ? 'border-rose-300/20 bg-rose-400/10' : 'border-violet-300/20 bg-violet-400/10'}`);
  if (['queued', 'running', 'retry_wait'].includes(active.status)) icon.append(node('span', undefined, 'h-5 w-5 animate-spin rounded-full border-2 border-violet-200/25 border-t-violet-200'));
  else icon.textContent = active.status === 'completed' ? '✓' : '!';
  icon.setAttribute('aria-hidden', 'true'); hero.append(icon);
  const copy = node('div', undefined, 'min-w-0 flex-1');
  const heading = node('div', undefined, 'flex flex-wrap items-center gap-2');
  heading.append(node('h2', statusLabels[active.status] || 'Analysis status', 'text-lg font-semibold tracking-tight text-white'));
  if (['queued', 'running', 'retry_wait'].includes(active.status)) heading.append(node('span', 'LIVE JOB', 'rounded-full border border-violet-300/20 bg-violet-400/10 px-2 py-1 text-[10px] font-semibold tracking-widest text-violet-200'));
  copy.append(heading);
  const stageLabels = { queued: 'Waiting to begin', analyzing_source: 'Analyzing source and checking evidence', saving_findings: 'Saving validated findings', retry_wait: 'Waiting for a safe retry', completed: 'All saved sources processed', failed: 'The current source was not committed' };
  copy.append(node('p', stageLabels[active.stage] || 'Analysis status saved', 'mt-1 text-sm leading-6 text-white/60'));
  hero.append(copy); panel.append(hero);
  const sourceDetails = active.currentSource && ['running', 'retry_wait'].includes(active.status)
    ? `Source ${Math.min(total, completed + 1)} of ${total}${source?.originalName ? ` · ${source.originalName}` : ''}`
    : `${completed} of ${total} sources complete`;
  const metrics = node('div', undefined, 'mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-white/[0.07] bg-black/10 px-4 py-3');
  metrics.append(node('span', sourceDetails, 'text-sm font-medium text-white/85'));
  metrics.append(node('span', `Stage · ${active.stage || active.status}`, 'text-xs text-white/45'));
  if (active.startedAt) {
    const elapsedLabel = node('span', `Elapsed ${formatElapsed(elapsed)}`, 'text-sm font-mono tabular-nums text-violet-200');
    elapsedLabel.id = 'analysisElapsedTime'; metrics.append(elapsedLabel);
  }
  panel.append(metrics);
  if (['queued', 'running', 'retry_wait'].includes(active.status) && active.startedAt && !analysisElapsedTimer) {
    analysisElapsedTimer = window.setInterval(() => {
      const current = state.analysisJob;
      const label = byId('analysisElapsedTime');
      if (!current || !['queued', 'running', 'retry_wait'].includes(current.status) || !current.startedAt || !label) return;
      label.textContent = `Elapsed ${formatElapsed(Date.now() - new Date(current.startedAt).getTime())} · Analysis may take several minutes.`;
    }, 1000);
  } else if ((!['queued', 'running', 'retry_wait'].includes(active.status) || !active.startedAt) && analysisElapsedTimer) {
    window.clearInterval(analysisElapsedTimer); analysisElapsedTimer = null;
  }
  const track = node('div', undefined, 'mt-3 h-1.5 rounded-full bg-white/10 overflow-hidden');
  const fill = node('div', undefined, 'h-full rounded-full bg-violet-400 transition-all');
  fill.style.width = `${total ? Math.round((completed / total) * 100) : 0}%`;
  track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', 'Completed sources'); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(total)); track.setAttribute('aria-valuenow', String(completed));
  track.append(fill); panel.append(track);
  panel.append(node('p', 'AI analysis and exact evidence verification can take several minutes. This display reflects saved server progress; it does not estimate time remaining.', 'mt-3 text-xs leading-5 text-white/45'));
  if (active.status === 'retry_wait' && active.retryAt) {
    const seconds = Math.max(0, Math.ceil((new Date(active.retryAt).getTime() - Date.now()) / 1000));
    panel.append(node('p', `Retrying after the saved backoff${seconds ? ` · about ${seconds}s` : ''}.`, 'mt-2 text-xs text-amber-200'));
  }
  if (active.status === 'failed') {
    const failureMessages = {
      gemini_timeout: 'The Gemini secondary provider did not respond before its request timeout. No findings were saved for this source.',
      cloudflare_timeout: 'The Cloudflare analysis provider did not respond before its request timeout. No findings were saved for this source.',
      gemini_provider: 'The Gemini secondary provider failed after its retry policy. No findings were saved for this source.',
      cloudflare_provider: 'The Cloudflare analysis provider failed after its retry policy. No findings were saved for this source.',
      gemini_invalid_response: 'Gemini output failed RELAY validation. No findings were saved for this source.',
      cloudflare_invalid_response: 'Cloudflare output failed RELAY schema or evidence validation. No findings were saved for this source.',
      gemini_configuration: 'Gemini is not configured correctly for this deployment.',
      cloudflare_configuration: 'The Cloudflare analysis provider is not configured correctly for this deployment.',
      step_budget_exceeded: 'Analysis exceeded its safe processing time. No findings were saved for this source.',
      source_unavailable: 'The source could not be read for analysis. No findings were saved for this source.',
      analysis_error: 'Analysis stopped before this source was committed. Check provider and function logs for the failure category.',
    };
    const reason = failureMessages[active.lastErrorKind] || (active.lastErrorKind === 'temporary_provider_failure'
      ? 'A temporary provider failure exhausted the automatic retry policy. No findings were saved for this source.'
      : 'The current source was not committed. Check the provider or source, then retry when ready.');
    panel.append(node('p', reason, 'mt-3 text-sm leading-5 text-rose-200'));
    if (Number.isInteger(active.lastErrorStatus)) panel.append(node('p', `Sanitized failure status: ${active.lastErrorStatus}`, 'mt-2 text-xs text-rose-100/55'));
    if (active.demoFallbackAvailable && !state.analysisStarting && !state.analysisAdvancing) {
      const demo = node('section', undefined, 'mt-5 rounded-2xl border border-amber-300/25 bg-amber-400/[0.06] p-4 sm:p-5');
      demo.append(node('p', DEMO_ANALYSIS_FALLBACK.label, 'inline-flex rounded-full border border-amber-200/30 bg-amber-300/10 px-3 py-1 text-[11px] font-bold tracking-wide text-amber-100'));
      demo.append(node('h3', 'Live analysis failed · sample demonstration opened', 'mt-3 text-base font-semibold text-white'));
      demo.append(node('p', 'Cloudflare and its eligible Gemini secondary fallback both failed. Your real project, sources, findings, and retry remain unchanged. The sample below is separate and is not part of this project.', 'mt-1 text-sm leading-6 text-white/65'));

      const report = node('div', undefined, 'mt-4 rounded-xl border border-white/10 bg-black/15 p-4');
      report.append(node('p', DEMO_ANALYSIS_FALLBACK.label, 'text-[10px] font-bold tracking-widest text-amber-100/80'));
      report.append(node('h4', 'Sample handover preview · Campus Connect', 'mt-2 text-sm font-semibold text-white'));
      report.append(node('p', 'Sample only · not saved, not approved, and unavailable to real handover generation.', 'mt-1 text-xs text-white/45'));

      const source = node('div', undefined, 'mt-4 rounded-xl border border-sky-200/10 bg-sky-300/[0.04] p-3');
      source.append(node('p', `Designated sample source · ${DEMO_ANALYSIS_FALLBACK.sourceName}`, 'text-xs font-semibold text-sky-100'));
      source.append(node('pre', DEMO_ANALYSIS_FALLBACK.sourceText, 'mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/20 p-3 font-mono text-xs leading-5 text-white/70'));
      report.append(source);

      const samples = node('div', undefined, 'mt-3 grid gap-3');
      DEMO_ANALYSIS_FALLBACK.findings.forEach((finding) => {
        const card = node('article', undefined, 'rounded-xl border border-amber-100/10 bg-white/[0.03] p-3');
        card.append(node('span', DEMO_ANALYSIS_FALLBACK.label, 'text-[9px] font-bold tracking-wide text-amber-100/75'));
        card.append(node('p', finding.category, 'mt-2 text-[10px] font-semibold uppercase tracking-wider text-violet-200/70'));
        card.append(node('h5', finding.title, 'mt-1 text-sm font-semibold text-white'));
        card.append(node('p', finding.description, 'mt-1 text-sm leading-5 text-white/60'));
        card.append(node('p', 'Sample source quote · exact passage from the designated sample document', 'mt-3 text-[10px] text-white/40'));
        card.append(node('blockquote', `“${finding.quote}”`, 'mt-1 border-l-2 border-amber-200/30 pl-3 text-xs leading-5 text-white/65'));
        samples.append(card);
      });
      report.append(samples);
      demo.append(report);
      panel.append(demo);
    }
    if (canManageCurrentProject()) {
      const retry = node('button', 'Retry failed source', 'mt-3 rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50');
      retry.type = 'button'; retry.disabled = state.analysisAdvancing || state.analysisStarting;
      retry.addEventListener('click', retryCurrentAnalysisJob); panel.append(retry);
    }
  }
  panel.append(node('p', 'This authenticated page advances the saved job one source at a time. An in-flight source may finish after you leave, then advancement pauses. Reopen the project to resume.', 'mt-4 border-t border-white/10 pt-4 text-xs leading-5 text-white/45'));
}

async function advanceSourceWithPolling(jobId, projectId) {
  // Keep the long-running advance request open while reading persisted progress
  // separately. Status polling never starts work and cannot duplicate a step.
  const advance = api(`/analysis-jobs/${encodeURIComponent(jobId)}/advance`, { method: 'POST', body: '{}' })
    .then((data) => ({ data }), (error) => ({ error }));
  while (true) {
    let timerId;
    const pollInterval = new Promise((resolve) => { timerId = window.setTimeout(() => resolve(null), 1500); });
    const outcome = await Promise.race([advance, pollInterval]);
    window.clearTimeout(timerId);
    if (outcome) {
      if (outcome.error) throw outcome.error;
      return outcome.data;
    }
    if (state.mode !== 'real' || String(state.selectedProjectId) !== projectId) return null;
    const current = (await api(`/analysis-jobs/${encodeURIComponent(jobId)}`)).job;
    if (String(state.selectedProjectId) !== projectId || String(current?.project) !== projectId) return null;
    state.analysisJob = current;
    renderAnalysisJob();
  }
}

async function loadAnalysisJob({ resume = false } = {}) {
  if (state.mode !== 'real' || !state.selectedProjectId) { renderAnalysisJob(); return null; }
  const projectId = state.selectedProjectId;
  try {
    const data = await api(`/projects/${encodeURIComponent(projectId)}/analysis-job`);
    if (projectId !== state.selectedProjectId || state.mode !== 'real') return null;
    state.analysisJob = data.job || null;
    state.analysisJobError = '';
    renderAnalysisJob();
    if (resume && state.analysisJob && ['queued', 'running', 'retry_wait'].includes(state.analysisJob.status) && canManageCurrentProject()) {
      runAnalysisJob(state.analysisJob._id);
    }
    return state.analysisJob;
  } catch (error) {
    if (projectId === state.selectedProjectId) { state.analysisJobError = error.message; renderAnalysisJob(); }
    return null;
  }
}

function runAnalysisJob(jobId) {
  if (analysisRunners.has(jobId)) return analysisRunners.get(jobId);
  const runProjectId = String(state.analysisJob?.project || '');
  const promise = (async () => {
    state.analysisAdvancing = true; renderAnalysisJob();
    try {
      while (state.mode === 'real' && state.selectedProjectId && String(state.selectedProjectId) === runProjectId) {
        const job = state.analysisJob?._id === jobId ? state.analysisJob : await (await api(`/analysis-jobs/${encodeURIComponent(jobId)}`)).job;
        if (String(job?.project) !== runProjectId || String(state.selectedProjectId) !== runProjectId) break;
        if (!job || ['completed', 'failed'].includes(job.status)) { state.analysisJob = job; break; }
        if (state.analysisJob?._id !== jobId) state.analysisJob = job;
        renderAnalysisJob();
        if (job.status === 'retry_wait' && job.retryAt && new Date(job.retryAt).getTime() > Date.now()) {
          await new Promise((resolve) => window.setTimeout(resolve, Math.min(2000, new Date(job.retryAt).getTime() - Date.now())));
          const current = (await api(`/analysis-jobs/${encodeURIComponent(jobId)}`)).job;
          if (String(state.selectedProjectId) !== runProjectId) break;
          state.analysisJob = current;
          continue;
        }
        if (job.leaseActive) {
          await new Promise((resolve) => window.setTimeout(resolve, 2000));
          const current = (await api(`/analysis-jobs/${encodeURIComponent(jobId)}`)).job;
          if (String(state.selectedProjectId) !== runProjectId) break;
          state.analysisJob = current;
          continue;
        }
        try {
          const result = await advanceSourceWithPolling(jobId, runProjectId);
          if (!result) break;
          if (String(state.selectedProjectId) === runProjectId) {
            state.analysisJob = result.job;
            state.analysisJobError = '';
            state.analysisJobDiagnostic = null;
            renderAnalysisJob();
          }
        } catch (error) {
          if (error.status !== 409) throw error;
          const current = (await api(`/analysis-jobs/${encodeURIComponent(jobId)}`)).job;
          if (String(state.selectedProjectId) === runProjectId) { state.analysisJob = current; renderAnalysisJob(); }
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
        }
        if (String(state.selectedProjectId) === runProjectId && state.analysisJob?.status === 'failed') break;
      }
      if (String(state.selectedProjectId) === runProjectId && state.analysisJob?._id === jobId && state.analysisJob.status === 'completed') {
        toast(`Analysis complete · ${state.analysisJob.completedSourceCount} source(s) processed.`);
        await loadProjectData();
      }
    } catch (error) {
      if (String(state.selectedProjectId) === runProjectId) { state.analysisJobError = error.message; state.analysisJobDiagnostic = error.diagnostic || null; renderAnalysisJob(); }
    } finally {
      analysisRunners.delete(jobId);
      state.analysisAdvancing = analysisRunners.size > 0;
      renderAnalysisJob();
    }
  })();
  analysisRunners.set(jobId, promise);
  return promise;
}

async function retryCurrentAnalysisJob() {
  const jobId = state.analysisJob?._id;
  const projectId = state.selectedProjectId;
  if (!jobId || state.analysisStarting || state.analysisAdvancing || !canManageCurrentProject()) return;
  state.analysisStarting = true; renderAnalysisJob();
  try {
    const result = await api(`/analysis-jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST', body: '{}' });
    if (state.selectedProjectId !== projectId) return;
    state.analysisJob = result.job; state.analysisJobError = '';
    renderAnalysisJob(); await runAnalysisJob(jobId);
  } catch (error) { if (state.selectedProjectId === projectId) { state.analysisJobError = error.message; renderAnalysisJob(); } }
  finally { state.analysisStarting = false; renderAnalysisJob(); }
}

async function simulateAnalyze() {
  if (state.mode === 'demo') { toast('DEMO DATA · sample findings are shown; no Gemini request was made.'); return; }
  if (!canManageCurrentProject()) { toast('Only project owners and editors can run project analysis.', 'error'); return; }
  if (!state.selectedProjectId) { toast('Select or create a project before analysis.', 'error'); return; }
  if (state.analysisStarting || state.analysisAdvancing) return;
  if (state.analysisJob?.status === 'failed') { await retryCurrentAnalysisJob(); return; }
  if (state.analysisJob && ['queued', 'running', 'retry_wait'].includes(state.analysisJob.status)) { runAnalysisJob(state.analysisJob._id); return; }
  if (!state.sources.some((source) => source.status === 'processed')) { toast('Upload at least one processed document before analysis.', 'error'); return; }
  const projectId = state.selectedProjectId;
  state.analysisStarting = true; state.analysisJobError = '';
  navigate('findings'); renderAnalysisJob();
  try {
    const data = await api(`/projects/${encodeURIComponent(projectId)}/analyze`, { method: 'POST', body: '{}' });
    if (state.selectedProjectId !== projectId) return;
    state.analysisJob = data.job || null;
    renderAnalysisJob();
    if (state.analysisJob) await runAnalysisJob(state.analysisJob._id);
    else { toast(data.message || 'All processed sources have already been analyzed.'); await loadProjectData(); }
  } catch (error) { state.analysisJobError = error.message; renderAnalysisJob(); toast(`Could not start analysis: ${error.message}`, 'error'); }
  finally { state.analysisStarting = false; renderAnalysisJob(); }
}

function renderCategoryFilters() {
  const container = byId('categoryFilters');
  if (!container) return;
  clear(container);
  categories.forEach((category) => {
    const button = node('button', category, `px-4 py-2 rounded-full text-xs font-medium border ${activeCat === category ? 'bg-white text-[#060A16] border-white' : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'}`);
    button.type = 'button'; button.addEventListener('click', () => { activeCat = category; renderCategoryFilters(); renderFindings(); });
    container.append(button);
  });
}

function renderAll() {
  renderDashboard();
  loadProjects();
  renderCategoryFilters();
}

function renderDashboard() {
  const activeProject = state.projects.find((project) => project._id === state.selectedProjectId);
  const approved = state.findings.filter((finding) => finding.status === 'approved').length;
  const pending = state.findings.filter((finding) => finding.status === 'pending').length;
  const evidenceCount = state.findings.reduce((total, finding) => total + (finding.evidence || []).length, 0);
  const confidence = state.findings.length ? Math.round(state.findings.reduce((total, finding) => total + (Number(finding.confidence) || 0), 0) / state.findings.length * 100) : null;
  const put = (id, text) => { const el = byId(id); if (el) el.textContent = String(text); };
  put('dashboardProjectCount', state.projects.length);
  put('dashboardSourceCount', state.errors.sources ? '—' : state.sources.length);
  put('dashboardFindingCount', state.errors.findings ? '—' : state.findings.length);
  put('dashboardPendingCount', state.errors.findings ? 'Findings unavailable' : `${pending} pending review`);
  put('dashboardApprovedCount', `${approved} approved`);
  put('dashboardPendingBadge', `${pending} pending`);
  const reviewUnavailable = state.errors.findings ? '—' : '';
  put('reviewPendingCount', `${reviewUnavailable}${reviewUnavailable ? '' : pending} Pending`);
  put('reviewApprovedCount', `${reviewUnavailable}${reviewUnavailable ? '' : approved} Approved`);
  put('reviewRejectedCount', `${reviewUnavailable}${reviewUnavailable ? '' : state.findings.filter((finding) => finding.status === 'rejected').length} Rejected`);
  put('reviewClarificationCount', `${reviewUnavailable}${reviewUnavailable ? '' : state.findings.filter((finding) => finding.status === 'needs_clarification').length} Needs Clarification`);
  put('dashboardReadiness', state.errors.findings ? '—' : `${state.findings.length ? Math.round(approved / state.findings.length * 100) : 0}%`);
  const readinessRing = byId('dashboardReadinessRing');
  if (readinessRing) readinessRing.setAttribute('stroke-dasharray', `${state.findings.length ? Math.round(approved / state.findings.length * 100) : 0} 100`);
  put('dashboardExtractedCount', state.findings.length);
  put('dashboardEvidenceCount', evidenceCount);
  put('dashboardConfidence', confidence === null ? '—' : `${confidence}%`);
  put('dashboardAccount', state.user?.email || state.user?.name || 'Signed in');
  put('dashboardCurrentProject', activeProject ? `${activeProject.name} · ${activeProject.status || 'active'}` : 'Select a project to view its summary.');
  put('workspaceAccount', state.user?.email || state.user?.name || 'Signed in');
  put('workspaceSelectedProject', activeProject ? `${activeProject.name} · ${activeProject.status || 'active'}` : 'Choose a project');
  put('dashboardSummary', state.errors.projects ? `Could not load workspace: ${state.errors.projects}` : activeProject ? `${activeProject.name}: ${state.errors.sources ? 'sources unavailable' : `${state.sources.length} source(s)`}, ${state.errors.findings ? 'findings unavailable' : `${state.findings.length} finding(s)`}.` : state.projects.length ? 'Select a project to review its sources and findings.' : 'Create a project to begin your first handover.');
  const badges = byId('dashboardProjectCount')?.closest('.glass')?.querySelector('.mt-3.flex');
  if (badges) { clear(badges); badges.append(node('span', activeProject?.status || 'No project selected', 'px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-400 text-[11px]')); }
  const sourceBar = document.querySelector('#view-dashboard .bg-sky-500.rounded-full');
  if (sourceBar) sourceBar.style.width = state.errors.sources ? '0%' : `${Math.min(100, state.sources.length * 10)}%`;
  const progress = byId('dashboardProgress');
  if (progress) {
    clear(progress);
    progress.append(node('p', state.errors.sources ? `Sources unavailable: ${state.errors.sources}` : activeProject ? `${state.sources.filter((source) => source.status === 'processed').length} of ${state.sources.length} sources processed` : 'Select a project to see source and finding status.', 'text-sm text-white/60'));
    progress.append(node('p', `${pending} finding(s) need review`, 'text-sm text-white/45'));
  }
  const activity = byId('recentActivity');
  if (activity) {
    clear(activity);
    const latest = [...state.sources].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 4);
    if (!latest.length) activity.append(node('p', activeProject ? 'No source activity yet.' : 'Select a project to view activity.', 'text-sm text-white/45'));
    latest.forEach((source) => activity.append(node('p', `${statusLabel(source.status)} · ${source.originalName}`, 'text-sm text-white/65')));
  }
  const pendingList = byId('pendingList');
  if (pendingList) {
    clear(pendingList);
    const items = state.findings.filter((finding) => finding.status === 'pending').slice(0, 3);
    if (!items.length) pendingList.append(node('p', activeProject ? 'No findings need review.' : 'Select a project to see pending findings.', 'text-sm text-white/45 text-center py-4'));
    items.forEach((finding) => pendingList.append(node('p', finding.title, 'text-sm text-white/75 bg-white/[0.04] border border-white/10 rounded-xl p-3')));
  }
  const projectTabSources = document.querySelector('[data-ptab="sources"]');
  const projectTabFindings = document.querySelector('[data-ptab="findings"]');
  if (projectTabSources) projectTabSources.textContent = `Sources (${state.errors.sources ? '—' : state.sources.length})`;
  if (projectTabFindings) projectTabFindings.textContent = `Findings (${state.errors.findings ? '—' : state.findings.length})`;
  document.querySelectorAll('.rfilter').forEach((button) => {
    const status = button.dataset.rfilter;
    const count = status === 'all' ? state.findings.length : state.findings.filter((finding) => finding.status === status).length;
    button.textContent = `${status === 'all' ? 'All' : statusLabel(status)} (${state.errors.findings ? '—' : count})`;
  });
  const navCounts = { dashboard: pending, projects: state.errors.projects ? '—' : state.projects.length, sources: state.errors.sources ? '—' : state.sources.length, findings: state.errors.findings ? '—' : state.findings.length, review: state.errors.findings ? '—' : pending };
  Object.entries(navCounts).forEach(([view, value]) => {
    const badge = document.querySelector(`[data-nav="${view}"] span`);
    if (badge) badge.textContent = String(value);
  });
}

function navigate(view) {
  document.querySelectorAll('[id^="view-"]').forEach((section) => section.classList.add('hidden'));
  byId(`view-${view}`)?.classList.remove('hidden');
  if (view === 'projects') byId('projectDetail')?.classList.toggle('hidden', !state.selectedProjectId);
  document.querySelectorAll('.nav-btn').forEach((button) => {
    const active = button.dataset.nav === view;
    button.classList.toggle('bg-white', active); button.classList.toggle('text-[#060A16]', active);
    button.classList.toggle('text-white/70', !active);
  });
  byId('sidebar').classList.add('-translate-x-full');
  if (view === 'projects') renderProjects();
  if (view === 'sources') renderSources();
  if (view === 'findings') renderFindings();
  if (view === 'review') renderReview();
  if (view === 'handover') { renderHandover(); loadHandovers(); }
  if (view === 'settings') { byId('settingsNameInput').value = state.user?.name || 'Campus Connect Demo'; byId('settingsEmailInput').value = state.user?.email || ''; }
  window.scrollTo(0, 0);
}

function setReviewFilter(value) { state.reviewFilter = value; renderReview(); }
let evidenceSourceId = '';
let evidenceRequest = 0;
function evidenceSourceIdentifier(evidence) {
  const source = evidence?.source;
  return typeof source === 'string' ? source : source?._id || '';
}
async function loadEvidenceSource(sourceId, evidence) {
  const requestId = ++evidenceRequest;
  const status = byId('sourceViewStatus');
  const panel = byId('originalSourcePanel');
  status.textContent = 'Loading source text…';
  panel.classList.remove('hidden');
  byId('sourceViewerText').textContent = '';
  try {
    const data = await api(`/sources/${encodeURIComponent(sourceId)}/content`);
    if (requestId !== evidenceRequest) return;
    const text = data.source?.extractedText || '';
    byId('sourceViewerName').textContent = data.source?.originalName || 'Source';
    const viewer = byId('sourceViewerText');
    const start = evidence?.verificationStatus === 'verified' ? evidence.startOffset : -1;
    const end = evidence?.verificationStatus === 'verified' ? evidence.endOffset : -1;
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end <= text.length) {
      viewer.append(document.createTextNode(text.slice(0, start)));
      const mark = node('mark', text.slice(start, end), 'bg-emerald-300/25 text-emerald-100 rounded px-0.5');
      viewer.append(mark, document.createTextNode(text.slice(end)));
    } else viewer.textContent = text || 'No extracted text is available for this source.';
    status.textContent = text ? 'Source text loaded. Displayed as plain text.' : 'No extracted text is available; download the original file to inspect it.';
  } catch (error) {
    if (requestId !== evidenceRequest) return;
    status.textContent = `Could not load source text: ${error.message}`;
  }
}
async function downloadEvidenceSource(sourceId) {
  if (!sourceId || state.mode === 'demo') { toast('Original file download is unavailable for demo data.', 'error'); return; }
  const status = byId('sourceViewStatus');
  status.textContent = 'Preparing original file…';
  try {
    const headers = new Headers();
    if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
    const response = await fetch(`${API_URL}/sources/${encodeURIComponent(sourceId)}/download`, { headers });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || `Download failed (${response.status})`);
    }
    const blobUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = byId('evSourceMeta').textContent || 'source';
    document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    status.textContent = 'Original file downloaded.';
  } catch (error) { status.textContent = `Could not download source: ${error.message}`; }
}
function openEvidence(findingId) {
  const finding = state.findings.find((item) => item._id === findingId);
  if (!finding) { toast('Evidence is unavailable for this item.', 'error'); return; }
  const evidence = finding.evidence?.[0];
  evidenceSourceId = evidenceSourceIdentifier(evidence);
  byId('evFile').textContent = `${evidence?.sourceName || evidence?.source?.originalName || 'Source reference'}${evidence?.section ? ` · ${evidence.section}` : ''}${state.mode === 'demo' ? ' · DEMO DATA' : ''}`;
  const quote = byId('evText');
  quote.textContent = evidence?.quote || 'No evidence quote is available for this finding.';
  const verified = evidence?.verificationStatus === 'verified' && typeof evidence?.matchedText === 'string' && Number.isInteger(evidence?.startOffset) && Number.isInteger(evidence?.endOffset);
  byId('evVerification').textContent = `${verified ? 'VERIFIED · EXACT MATCH' : 'UNVERIFIED · EXACT MATCH NOT ESTABLISHED'}${state.mode === 'demo' ? ' · DEMO DATA' : ''}`;
  byId('evVerification').className = `text-xs font-mono tracking-widest mb-3 ${verified ? 'text-emerald-300' : 'text-amber-300'}`;
  byId('evMatchedLabel').classList.toggle('hidden', !verified);
  byId('evMatchedText').textContent = verified ? evidence.matchedText : 'No exact matched passage is available. The model quote is shown unchanged above.';
  const sourceName = evidence?.sourceName || evidence?.source?.originalName || 'Source details unavailable';
  const source = state.sources.find((item) => item.originalName === sourceName || item._id === evidence?.source?._id);
  byId('evSourceMeta').textContent = sourceName;
  byId('evSourceType').textContent = sourceName.includes('.') ? sourceName.split('.').pop().toUpperCase() : 'Unknown';
  byId('evSourceStatus').textContent = source ? statusLabel(source.status) : 'Unavailable';
  byId('sourceViewStatus').textContent = state.mode === 'demo' ? 'DEMO DATA · Original source files are not connected to the live workspace.' : '';
  byId('originalSourcePanel').classList.add('hidden');
  byId('sourceViewerText').textContent = '';
  byId('openSourceButton').disabled = !evidenceSourceId || state.mode === 'demo';
  byId('downloadSourceButton').disabled = !evidenceSourceId || state.mode === 'demo';
  byId('openSourceButton').onclick = () => loadEvidenceSource(evidenceSourceId, evidence);
  byId('downloadSourceButton').onclick = () => downloadEvidenceSource(evidenceSourceId);
  byId('evidenceModal').classList.remove('hidden');
}
function closeEvidence() { evidenceRequest += 1; byId('evidenceModal')?.classList.add('hidden'); }
function renderHandover() {
  const preview = byId('reportPreview');
  const history = byId('versionHistory');
  if (!preview || !history) return;
  clear(preview); clear(history);
  const versionSelect = byId('handoverVersionSelect');
  if (versionSelect) {
    clear(versionSelect);
    versionSelect.add(new Option(state.handovers.length ? 'Select a version' : 'No versions', ''));
    state.handovers.forEach((item) => versionSelect.add(new Option(`Version ${item.version}`, item._id)));
    versionSelect.value = state.selectedHandoverId;
  }
  const selectedProject = state.projects.find((item) => item._id === state.selectedProjectId);
  const role = selectedProject && String(selectedProject.owner) === String(state.user?.id)
    ? 'owner'
    : selectedProject?.members?.find((item) => String(item.user?._id || item.user) === String(state.user?.id))?.role || 'viewer';
  const generateButton = byId('generateHandoverButton');
  const downloadButton = byId('downloadHandoverButton');
  const generatedBadge = byId('handoverGeneratedBadge');
  if (generateButton) generateButton.disabled = state.mode === 'demo' || !state.selectedProjectId || !['owner', 'editor'].includes(role) || state.handoverBusy;
  if (downloadButton) downloadButton.disabled = state.mode === 'demo' || !state.selectedHandoverId || state.handoverDownloading;
  if (generateButton) generateButton.classList.toggle('opacity-50', generateButton.disabled);
  if (downloadButton) downloadButton.classList.toggle('opacity-50', downloadButton.disabled);
  if (generatedBadge) {
    const selectedVersion = state.handovers.find((item) => item._id === state.selectedHandoverId);
    generatedBadge.textContent = state.mode === 'demo' ? 'DEMO DATA' : selectedVersion ? `VERSION ${selectedVersion.version} · SAVED` : 'NO REPORT GENERATED';
    generatedBadge.className = `text-xs font-bold px-3 py-1 rounded-full ${selectedVersion && state.mode !== 'demo' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/10 text-white/50'}`;
  }
  const status = byId('handoverStatus');
  if (status) status.textContent = state.mode === 'demo'
    ? 'DEMO DATA · Reports are not generated or exported from the sample workspace.'
    : state.handoverLoading ? 'Loading saved handover versions…'
      : state.handoverBusy ? 'Generating and saving a new snapshot…'
        : !state.selectedProjectId ? 'Select a project to view its reports.'
              : state.handoverError ? `Could not load reports: ${state.handoverError}`
                : state.handoverActionError ? state.handoverActionError
            : role === 'viewer' ? 'Viewer access · You can read and download reports.'
              : 'Only approved findings are included in each generated snapshot.';

  if (state.mode === 'demo') {
    setStatus(history, 'DEMO DATA · Sample workspace has no generated handover versions.', 'info');
    setStatus(preview, 'No live report exists in demo mode. Sign in and select a real project to generate a report from approved findings.', 'info');
    return;
  }
  if (state.handoverLoading) { setStatus(history, 'Loading report history…', 'loading'); setStatus(preview, 'Loading report preview…', 'loading'); return; }
  if (state.handoverError) { setStatus(history, `Could not load report history: ${state.handoverError}`, 'error'); setStatus(preview, `Could not load report: ${state.handoverError}`, 'error'); return; }
  if (!state.selectedProjectId) { setStatus(history, 'Select a project to view its reports.'); setStatus(preview, 'No project selected.'); return; }
  if (!state.handovers.length) { setStatus(history, 'No handover versions yet. Generate one after approving findings.'); setStatus(preview, 'No report has been generated for this project.'); return; }
  const handover = state.handovers.find((item) => item._id === state.selectedHandoverId) || state.handovers[0];
  state.selectedHandoverId = handover._id;
  if (versionSelect) versionSelect.value = handover._id;
  const report = handover.reportContent || {};
  const article = node('article', undefined, 'rounded-xl bg-white p-5 md:p-8 text-[#0A0F1E]');
  article.append(node('p', `RELAY · HANDOVER VERSION ${handover.version}`, 'font-mono text-xs font-bold tracking-widest text-violet-700'));
  article.append(node('h2', report.project?.name || 'Project handover', 'mt-3 font-serif text-2xl'));
  article.append(node('p', `Generated ${report.generatedAt ? new Date(report.generatedAt).toLocaleString() : 'date unavailable'} by ${report.generatedBy?.name || handover.createdBy?.name || 'RELAY user'} · ${report.approvedFindingCount || 0} approved finding(s)`, 'mt-1 text-xs text-black/50'));
  if (report.emptyMessage) article.append(node('p', report.emptyMessage, 'mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900'));
  for (const [sectionName, items] of Object.entries(report.sections || {})) {
    const section = node('section', undefined, 'mt-5 border-t border-slate-200 pt-4');
    section.append(node('h3', sectionName, 'font-semibold text-base'));
    if (!items?.length) section.append(node('p', 'No approved information available.', 'mt-2 text-sm text-black/45 italic'));
    (items || []).forEach((item) => {
      if (item.title) section.append(node('h4', item.title, 'mt-3 font-medium text-sm'));
      if (item.description) section.append(node('p', item.description, 'mt-1 text-sm leading-relaxed text-black/65 whitespace-pre-wrap'));
      (item.evidence || []).forEach((evidence) => {
        const evidenceCard = node('div', undefined, 'mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3');
        evidenceCard.append(node('p', `Source · ${evidence.sourceName || 'Source filename unavailable'}`, 'text-xs font-medium text-slate-600 break-words'));
        const verified = evidence.verificationStatus === 'verified' && typeof evidence.matchedText === 'string';
        if (verified && evidence.quote) evidenceCard.append(node('p', `Original model quote · ${evidence.quote}`, 'mt-2 text-sm leading-relaxed whitespace-pre-wrap text-slate-600'));
        evidenceCard.append(node('p', verified ? `VERIFIED EXACT PASSAGE · ${evidence.matchedText}` : `UNVERIFIED MODEL QUOTE · ${evidence.quote || 'No quote available'}`, `mt-2 text-sm leading-relaxed whitespace-pre-wrap ${verified ? 'text-emerald-800' : 'text-amber-800'}`));
        if (!verified) evidenceCard.append(node('p', 'This quote was not verified as an exact match in the original source.', 'mt-1 text-xs text-amber-700'));
        section.append(evidenceCard);
      });
    });
    article.append(section);
  }
  preview.append(article);
  clear(history);
  state.handovers.forEach((item) => {
    const button = node('button', undefined, `w-full text-left rounded-xl border px-3 py-3 text-sm transition ${item._id === handover._id ? 'border-violet-400/50 bg-violet-500/15 text-white' : 'border-white/10 bg-white/[0.04] text-white/75 hover:bg-white/[0.08]'}`);
    button.type = 'button';
    button.append(node('span', `Version ${item.version}`, 'block font-medium'));
    button.append(node('span', `${new Date(item.createdAt).toLocaleDateString()} · ${item.reportContent?.approvedFindingCount || 0} approved findings`, 'block mt-1 text-xs text-white/45'));
    button.addEventListener('click', () => selectHandoverVersion(item._id));
    history.append(button);
  });
}
async function loadHandovers() {
  if (state.mode === 'demo' || !state.selectedProjectId) { state.handovers = []; state.selectedHandoverId = ''; renderHandover(); return; }
  const requestId = ++handoverRequest;
  const projectId = state.selectedProjectId;
  state.handoverLoading = true; state.handoverError = ''; renderHandover();
  try {
    const result = await api(`/projects/${encodeURIComponent(projectId)}/handovers`);
    if (requestId !== handoverRequest || projectId !== state.selectedProjectId) return;
    state.handovers = result.handovers || [];
    if (!state.handovers.some((item) => item._id === state.selectedHandoverId)) state.selectedHandoverId = state.handovers[0]?._id || '';
  } catch (error) {
    if (requestId !== handoverRequest || projectId !== state.selectedProjectId) return;
    state.handovers = []; state.selectedHandoverId = ''; state.handoverError = error.message;
  } finally {
    if (requestId === handoverRequest) { state.handoverLoading = false; renderHandover(); }
  }
}
function selectHandoverVersion(handoverId) { state.selectedHandoverId = handoverId; renderHandover(); }
async function generateReport() {
  if (state.mode === 'demo' || !state.selectedProjectId || state.handoverBusy) return;
  state.handoverBusy = true; state.handoverError = ''; state.handoverActionError = ''; renderHandover();
  try {
    await api(`/projects/${encodeURIComponent(state.selectedProjectId)}/handover`, { method: 'POST', body: '{}' });
    await loadHandovers();
    toast('Handover snapshot generated and saved.');
  } catch (error) { state.handoverActionError = `Could not generate a new report: ${error.message}`; toast(`Could not generate handover: ${error.message}`, 'error'); }
  finally { state.handoverBusy = false; renderHandover(); }
}
async function downloadPDF() {
  const status = byId('handoverStatus');
  if (state.mode === 'demo') { if (status) status.textContent = 'DEMO DATA · PDF downloads are unavailable for sample content.'; return; }
  if (!state.selectedHandoverId) { if (status) status.textContent = 'Select a saved handover version before downloading.'; toast('Select a saved handover version first.', 'error'); return; }
  if (state.handoverDownloading) return;
  const selected = state.handovers.find((item) => item._id === state.selectedHandoverId);
  const handoverId = state.selectedHandoverId;
  state.handoverDownloading = true;
  const button = byId('downloadHandoverButton');
  try {
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    if (status) status.textContent = `Preparing PDF for Version ${selected?.version || 'selected'}…`;
    const headers = new Headers();
    if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
    const downloadUrl = `${API_URL}/handovers/${encodeURIComponent(handoverId)}/download`;
    const response = await fetch(downloadUrl, { headers });
    if (!response.ok) {
      const data = response.headers.get('content-type')?.includes('application/json') ? await response.json().catch(() => ({})) : {};
      throw new Error(data.message || `Download failed (${response.status}).`);
    }
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/pdf') throw new Error(`The server returned ${contentType || 'an unknown file type'} instead of a PDF.`);
    const blob = await response.blob();
    if (blob.size < 5 || new TextDecoder().decode(await blob.slice(0, 5).arrayBuffer()) !== '%PDF-') throw new Error('The server response was not a valid PDF file.');
    const blobUrl = URL.createObjectURL(blob);
    const disposition = response.headers.get('content-disposition') || '';
    const responseFilename = disposition.match(/filename="?([^";]+)"?/i)?.[1];
    const fallbackFilename = `relay-handover-v${selected?.version || 1}.pdf`;
    const filename = (responseFilename || fallbackFilename).replace(/[^a-z\d._-]/gi, '_');
    const link = document.createElement('a'); link.href = blobUrl; link.download = filename; link.style.display = 'none';
    document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    if (status) status.textContent = `PDF download started for Version ${selected?.version || 'selected'}.`;
  } catch (error) { if (status) status.textContent = `Could not download PDF: ${error.message}`; toast(error.message, 'error'); }
  finally {
    state.handoverDownloading = false;
    if (button) { button.removeAttribute('aria-busy'); button.disabled = state.mode === 'demo' || !state.selectedHandoverId; }
  }
}
function downloadZip() { toast('Project archive · Coming soon.', 'error'); }
function openProject(id) { selectProject(id); navigate('sources'); }
function switchProjectTab(tab) {
  document.querySelectorAll('.ptab').forEach((button) => {
    const active = button.dataset.ptab === tab;
    button.classList.toggle('bg-white', active); button.classList.toggle('text-[#060A16]', active);
    button.classList.toggle('text-white/60', !active);
  });
  const content = byId('projectTabContent');
  clear(content);
  const project = state.projects.find((item) => item._id === state.selectedProjectId);
  if (tab === 'overview') {
    content?.append(node('p', project?.description || 'Select a project to view its overview.', 'text-sm text-white/60'));
    content?.append(node('p', `${state.sources.length} source(s) · ${state.findings.length} finding(s)`, 'mt-3 text-xs text-white/40'));
  } else if (tab === 'team') renderTeam();
  else if (tab === 'sources' || tab === 'findings') navigate(tab);
  else if (tab === 'handover') navigate('handover');
}

function isProjectOwner() {
  const project = state.projects.find((item) => item._id === state.selectedProjectId);
  return Boolean(project && state.user?.id && String(project.owner) === String(state.user.id));
}

async function renderTeam() {
  const content = byId('projectTabContent');
  if (!content) return;
  clear(content);
  if (!state.selectedProjectId) { setStatus(content, 'Select a project to view its team.'); return; }
  if (state.mode === 'demo') {
    content.append(node('p', 'DEMO DATA · Team management is available in your real authenticated projects.', 'text-sm text-violet-200/80'));
    return;
  }
  const projectId = encodeURIComponent(state.selectedProjectId);
  const section = node('div', undefined, 'space-y-4');
  const heading = node('div', undefined, 'flex flex-wrap items-center justify-between gap-3');
  heading.append(node('div', undefined, ''), node('span', 'Loading team…', 'text-xs text-white/40'));
  heading.firstChild.append(node('h4', 'Project team', 'text-white font-semibold'), node('p', 'Access is limited to the owner and invited members.', 'text-xs text-white/40 mt-1'));
  section.append(heading);
  content.append(section);
  try {
    const data = await api(`/projects/${projectId}/members`);
    if (state.selectedProjectId !== decodeURIComponent(projectId)) return;
    clear(section);
    const top = node('div', undefined, 'flex flex-wrap items-center justify-between gap-3');
    const title = node('div', undefined, '');
    title.append(node('h4', 'Project team', 'text-white font-semibold'), node('p', 'Members can read project sources, findings, evidence, and review history according to their role.', 'text-xs text-white/40 mt-1'));
    top.append(title, node('span', `${data.members?.length || 0} member(s)`, 'rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/65'));
    section.append(top);

    const memberList = node('div', undefined, 'space-y-2');
    const members = data.members || [];
    if (!members.length) memberList.append(node('p', 'No team members are available.', 'text-sm text-white/45 py-4'));
    members.forEach((member) => {
      const row = node('div', undefined, 'flex flex-col md:flex-row md:items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3');
      const identity = node('div', undefined, 'flex-1 min-w-0');
      identity.append(node('p', member.user?.name || 'RELAY member', 'text-sm font-medium text-white break-words'), node('p', member.user?.email || '', 'text-xs text-white/45 break-all mt-0.5'));
      row.append(identity);
      if (member.role === 'owner') row.append(node('span', 'OWNER', 'text-[10px] font-mono tracking-wider rounded-full bg-violet-500/20 px-3 py-1.5 text-violet-200'));
      else if (data.canManageMembers) {
        const controls = node('div', undefined, 'flex flex-wrap items-center gap-2');
        const role = document.createElement('select');
        role.className = 'bg-[#111B34] border border-white/10 rounded-full px-3 py-2 text-xs text-white';
        role.setAttribute('aria-label', `Role for ${member.user?.email || 'member'}`);
        [['editor', 'Editor'], ['viewer', 'Viewer']].forEach(([value, label]) => role.add(new Option(label, value)));
        role.value = member.role === 'editor' ? 'editor' : 'viewer';
        const save = node('button', 'Save role', 'rounded-full bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/15');
        save.type = 'button';
        save.addEventListener('click', () => changeMemberRole(member.memberId, role.value));
        const remove = node('button', 'Remove', 'rounded-full bg-rose-500/15 px-3 py-2 text-xs text-rose-200 hover:bg-rose-500/25');
        remove.type = 'button';
        remove.addEventListener('click', () => removeProjectMember(member.memberId, member.user?.email || member.user?.name || 'this member'));
        controls.append(role, save, remove); row.append(controls);
      } else row.append(node('span', member.role === 'editor' ? 'EDITOR' : 'VIEWER', 'text-[10px] font-mono tracking-wider rounded-full bg-white/10 px-3 py-1.5 text-white/65'));
      memberList.append(row);
    });
    section.append(memberList);
    if (data.canManageMembers) {
      if (members.filter((member) => member.role !== 'owner').length === 0) section.append(node('p', 'No collaborators yet. Add a registered RELAY user to share this project.', 'text-xs text-white/45'));
      const form = document.createElement('form');
      form.className = 'rounded-2xl border border-white/10 bg-[#0B122A] p-4';
      form.append(node('h5', 'Add a team member', 'text-sm font-semibold text-white'), node('p', 'They must already have a RELAY account. No email invitation is sent.', 'text-xs text-white/40 mt-1'));
      const controls = node('div', undefined, 'mt-3 flex flex-col sm:flex-row gap-2');
      const email = document.createElement('input'); email.type = 'email'; email.required = true; email.maxLength = 254; email.placeholder = 'name@example.com'; email.autocomplete = 'email'; email.className = 'flex-1 min-w-0 bg-[#111B34] border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white'; email.setAttribute('aria-label', 'Existing RELAY user email');
      const role = document.createElement('select'); role.className = 'bg-[#111B34] border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white'; role.add(new Option('Editor', 'editor')); role.add(new Option('Viewer', 'viewer'));
      const submit = node('button', 'Add member', 'rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500'); submit.type = 'submit';
      controls.append(email, role, submit);
      const message = node('p', '', 'hidden text-xs mt-3'); message.id = 'teamFormMessage';
      form.append(controls, message);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        submit.disabled = true; submit.textContent = 'Adding…'; message.className = 'hidden text-xs mt-3';
        try {
          await api(`/projects/${projectId}/members`, { method: 'POST', body: JSON.stringify({ email: email.value.trim(), role: role.value }) });
          toast('Member added to project');
          await renderTeam();
        } catch (error) { message.textContent = error.message; message.className = 'text-xs mt-3 text-rose-300'; }
        finally { submit.disabled = false; submit.textContent = 'Add member'; }
      });
      section.append(form);
    } else section.append(node('p', 'Only the project owner can add, change, or remove members.', 'text-xs text-white/40'));
  } catch (error) {
    clear(section);
    const retry = node('button', `Could not load team: ${error.message} · Retry`, 'rounded-xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-left text-sm text-rose-200');
    retry.type = 'button'; retry.addEventListener('click', renderTeam); section.append(retry);
  }
}

async function changeMemberRole(memberId, role) {
  if (!isProjectOwner() || !window.confirm(`Change this project member to ${role}?`)) return;
  try {
    await api(`/projects/${encodeURIComponent(state.selectedProjectId)}/members/${encodeURIComponent(memberId)}`, { method: 'PATCH', body: JSON.stringify({ role }) });
    toast('Member role updated'); await renderTeam();
  } catch (error) { toast(`Could not update member role: ${error.message}`, 'error'); }
}

async function removeProjectMember(memberId, label) {
  if (!isProjectOwner() || !window.confirm(`Remove ${label} from this project? They will lose access immediately.`)) return;
  try {
    await api(`/projects/${encodeURIComponent(state.selectedProjectId)}/members/${encodeURIComponent(memberId)}`, { method: 'DELETE' });
    toast('Member removed from project'); await renderTeam();
  } catch (error) { toast(`Could not remove member: ${error.message}`, 'error'); }
}

function searchFindings(value) {
  const input = byId('findingSearch');
  if (input) input.value = value;
  navigate('findings'); renderFindings();
}

function bindEvents() {
  const downloadButton = byId('downloadHandoverButton');
  downloadButton?.addEventListener('click', downloadPDF);
  const authForm = byId('authForm');
  authForm?.addEventListener('submit', login);
  byId('dropzone')?.addEventListener('dragover', (event) => { event.preventDefault(); byId('dropzone').classList.add('border-violet-500'); });
  byId('dropzone')?.addEventListener('dragleave', () => byId('dropzone').classList.remove('border-violet-500'));
  byId('dropzone')?.addEventListener('drop', (event) => { event.preventDefault(); byId('dropzone').classList.remove('border-violet-500'); handleUpload(event.dataTransfer.files); });
  byId('projectSearch')?.addEventListener('input', renderProjects);
  byId('projectFilter')?.addEventListener('change', renderProjects);
  byId('findingSearch')?.addEventListener('input', renderFindings);
  byId('findingStatus')?.addEventListener('change', renderFindings);
  byId('globalSearch')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') searchFindings(event.currentTarget.value); });
  byId('globalSearch')?.addEventListener('input', (event) => { if (!event.currentTarget.value) { byId('findingSearch').value = ''; renderFindings(); } });
  byId('reviewEditForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const findingId = byId('reviewEditModal').dataset.findingId;
    const payload = { title: byId('reviewEditTitleInput').value, category: byId('reviewEditCategory').value, description: byId('reviewEditDescription').value };
    submitReviewAction(findingId, 'edit', payload);
  });
  byId('reviewCommentForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = byId('reviewCommentText').value.trim();
    if (!value) { byId('reviewCommentError').textContent = commentAction === 'reject' ? 'A rejection reason is required.' : commentAction === 'reopen' ? 'A reopening reason is required.' : 'A clarification comment is required.'; byId('reviewCommentError').classList.remove('hidden'); return; }
    submitReviewAction(commentFindingId, commentAction, commentAction === 'clarify' ? { comment: value } : { reason: value });
  });
}

async function restoreSession() {
  if (!state.token) return;
  const token = state.token;
  const attempt = ++authGeneration;
  try {
    const data = await api('/auth/me');
    if (attempt !== authGeneration || state.mode !== 'real' || state.token !== token) return;
    state.user = data.user;
    showApp();
  } catch { if (attempt === authGeneration && state.mode === 'real') expireSession(); }
}

Object.assign(window, { login, toggleAuthMode, logout, togglePass, toggleSidebar, navigate, openCreateProject, selectProject, handleUpload, simulateAnalyze, setReviewFilter, openEvidence, closeEvidence, closeReviewDialogs, generateReport, downloadPDF, downloadZip, openProject, switchProjectTab, renderProjects, renderFindings, renderSources, enterDemo, exitDemo, searchFindings, renderHandover, selectHandoverVersion });
bindEvents();
try {
  if (window.lucide) window.lucide.createIcons();
} catch (error) {
  console.error('Lucide icon initialization failed', error);
}
restoreSession();
