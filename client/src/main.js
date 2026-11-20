import { createClient } from '@supabase/supabase-js';
import './styles.css';
import { remainingSplashTime, resolveInitialRoute } from './startupFlow.js';
import { createAuthRequest, isRegistrationPasswordValid } from './authFlow.js';
import { DEMO_ANALYSIS_FALLBACK } from './data/demoAnalysisFallback.js';
import { canRetryGitHubSync, canSyncGitHubRepository, createGitHubActionButton, createUiNode, githubConnectionLabel, githubInstallationStatusLabel, githubSyncErrorMessage, githubSyncStageLabel, githubSyncStatusLabel, isProjectOwner as isCurrentProjectOwner } from './githubUi.js';
import { canReadProjectAudit as canReadProjectAuditForUser, canReviewContradiction as canReviewContradictionForUser, canSignHandover as canSignHandoverForUser, contradictionEvidenceView, contradictionStatusLabel, dashboardMetrics, deletionErrorMessage, isDeletionRecoverable, projectCardMetrics, projectDeletionCardPresentation, validateReviewerRationale, validateSignoffInput } from './round3WorkflowUi.js';

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
const state = { mode: 'real', token: localStorage.getItem(TOKEN_KEY), user: null, projects: [], selectedProjectId: '', sources: [], findings: [], assignments: [], assignmentError: '', dashboardAuditEvents: [], dashboardAuditError: '', contradictions: [], contradictionError: '', contradictionLoading: false, contradictionBusyId: '', contradictionHistory: {}, handoverSignoffs: {}, handoverSignoffError: '', handoverSignoffBusyId: '', projectDeletion: null, projectDeletionError: '', projectDeletionLoading: false, projectDeletionBusy: false, githubRepositories: [], githubInstallations: [], githubAvailableRepositories: [], githubDiscoveryInstallationId: '', githubDiscoveryLoading: false, githubDiscoveryError: '', githubLinkingRepositoryId: '', githubAuthorizing: false, githubNotice: '', githubError: '', githubLoading: false, githubBusyLinkId: '', githubRetryingJobId: '', sourceRevisionCache: {}, analysisSelection: new Set(), handovers: [], selectedHandoverId: '', handoverError: '', handoverActionError: '', handoverLoading: false, handoverBusy: false, handoverDownloading: false, analysisJob: null, analysisJobError: '', analysisJobDiagnostic: null, analysisStarting: false, analysisAdvancing: false, errors: { projects: '', sources: '', findings: '' }, authMode: 'login', busy: false, reviewBusy: false, reviewFilter: 'all', sourceUploadBusy: false };
let authGeneration = 0;
let handoverRequest = 0;
const analysisRunners = new Map();
let analysisElapsedTimer = null;
let githubPollTimer = null;
let githubPollController = null;
let githubPollGeneration = 0;
let githubPollCount = 0;
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
const node = (tag, text, className) => createUiNode(document, tag, text, className);
const clear = (el) => el?.replaceChildren();

function accessibleFormDialog({ title, description = '', fields, submitLabel = 'Continue', danger = false }) {
  return new Promise((resolve) => {
    const dialog = node('dialog', undefined, 'w-[min(92vw,34rem)] rounded-2xl border border-white/15 bg-slate-900 p-0 text-white shadow-2xl backdrop:bg-black/70');
    const form = node('form', undefined, 'space-y-4 p-6'); form.method = 'dialog';
    const heading = node('h2', title, 'text-lg font-semibold'); heading.id = `dialog-title-${Date.now()}`;
    form.setAttribute('aria-labelledby', heading.id);
    form.append(heading);
    if (description) {
      const help = node('p', description, 'text-sm leading-6 text-white/65');
      help.id = `dialog-description-${heading.id}`; dialog.setAttribute('aria-describedby', help.id); form.append(help);
    }
    const controls = [];
    for (const field of fields) {
      const wrapper = node('div', undefined, 'space-y-2');
      const label = node('label', field.label, 'block text-sm text-white/80');
      const input = node(field.type === 'text' ? 'input' : 'textarea', undefined, `${field.type === 'text' ? 'w-full' : 'min-h-28 w-full'} rounded-lg border border-white/15 bg-black/20 p-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-violet-400`);
      if (field.type === 'text') input.type = 'text';
      input.id = `dialog-field-${Date.now()}-${controls.length}`; label.htmlFor = input.id;
      input.required = Boolean(field.required); input.maxLength = field.maxLength || 5000;
      input.placeholder = field.placeholder || '';
      if (field.help) input.setAttribute('aria-describedby', `${input.id}-help`);
      wrapper.append(label, input);
      if (field.help) { const help = node('p', field.help, 'text-xs text-white/45'); help.id = `${input.id}-help`; wrapper.append(help); }
      form.append(wrapper); controls.push(input);
    }
    const actions = node('div', undefined, 'flex justify-end gap-3 pt-2');
    const cancel = node('button', 'Cancel', 'rounded-full border border-white/15 px-4 py-2 text-sm text-white/75 hover:bg-white/5');
    cancel.type = 'button';
    const submit = node('button', submitLabel, `rounded-full px-4 py-2 text-sm font-semibold ${danger ? 'bg-rose-600 hover:bg-rose-500' : 'bg-violet-600 hover:bg-violet-500'}`);
    submit.type = 'submit'; actions.append(cancel, submit); form.append(actions); dialog.append(form); document.body.append(dialog);
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; dialog.close(); dialog.remove(); resolve(value); };
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    form.addEventListener('submit', (event) => { event.preventDefault(); finish(controls.map((control) => control.value)); });
    dialog.addEventListener('close', () => finish(null), { once: true });
    dialog.showModal(); controls[0]?.focus();
  });
}

async function confirmInApp(message, title = 'Confirm action', danger = false) {
  const result = await accessibleFormDialog({ title, description: message, fields: [], submitLabel: 'Confirm', danger });
  return result !== null;
}

function stopGitHubPolling() {
  githubPollGeneration += 1;
  if (githubPollTimer) window.clearTimeout(githubPollTimer);
  githubPollTimer = null;
  githubPollController?.abort();
  githubPollController = null;
  githubPollCount = 0;
}

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
    error.code = data.code;
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
  stopGitHubPolling();
  state.mode = 'real';
  state.token = null;
  state.user = null;
  state.projects = [];
  state.selectedProjectId = '';
  state.sources = [];
  state.findings = [];
  state.assignments = [];
  state.assignmentError = '';
  state.contradictions = []; state.contradictionError = ''; state.contradictionHistory = {};
  state.handoverSignoffs = {}; state.handoverSignoffError = '';
  state.projectDeletion = null; state.projectDeletionError = '';
  state.githubRepositories = [];
  state.githubInstallations = [];
  state.githubAvailableRepositories = [];
  state.githubDiscoveryInstallationId = '';
  state.githubDiscoveryLoading = false;
  state.githubDiscoveryError = '';
  state.githubNotice = '';
  state.githubError = '';
  state.sourceRevisionCache = {};
  state.analysisSelection = new Set();
  state.handovers = [];
  state.analysisJob = null;
  state.analysisJobError = '';
  state.errors = { projects: '', sources: '', findings: '' };
  localStorage.removeItem(TOKEN_KEY);
  byId('app').classList.add('hidden');
  byId('authOverlay').classList.remove('hidden');
}

function enterDemo() {
  stopGitHubPolling();
  authGeneration += 1;
  state.mode = 'demo';
  state.token = null;
  state.user = { name: 'Campus Connect Demo', email: 'demo@campusconnect.example' };
  state.projects = [{ ...DEMO_WORKSPACE.project }];
  state.selectedProjectId = DEMO_WORKSPACE.project._id;
  state.sources = structuredClone(DEMO_WORKSPACE.sources);
  state.findings = structuredClone(DEMO_WORKSPACE.findings);
  state.assignments = [];
  state.assignmentError = '';
  state.contradictions = []; state.contradictionError = ''; state.contradictionHistory = {};
  state.handoverSignoffs = {}; state.handoverSignoffError = '';
  state.projectDeletion = null; state.projectDeletionError = '';
  state.githubRepositories = [];
  state.githubInstallations = [];
  state.githubAvailableRepositories = [];
  state.githubDiscoveryInstallationId = '';
  state.githubNotice = '';
  state.githubError = '';
  state.sourceRevisionCache = {};
  state.analysisSelection = new Set();
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
  stopGitHubPolling();
  authGeneration += 1;
  state.mode = 'real';
  state.token = localStorage.getItem(TOKEN_KEY);
  state.projects = [];
  state.selectedProjectId = '';
  state.sources = [];
  state.findings = [];
  state.assignments = [];
  state.assignmentError = '';
  state.contradictions = []; state.contradictionError = ''; state.contradictionHistory = {};
  state.handoverSignoffs = {}; state.handoverSignoffError = '';
  state.projectDeletion = null; state.projectDeletionError = '';
  state.githubRepositories = [];
  state.githubInstallations = [];
  state.githubAvailableRepositories = [];
  state.githubDiscoveryInstallationId = '';
  state.githubNotice = '';
  state.githubError = '';
  state.sourceRevisionCache = {};
  state.analysisSelection = new Set();
  state.handovers = [];
  state.analysisJob = null;
  state.analysisJobError = '';
  state.errors = { projects: '', sources: '', findings: '' };
  byId('app').classList.add('hidden');
  byId('authOverlay').classList.remove('hidden');
  byId('authEmail')?.focus();
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
  byId('authHeading').textContent = registering ? 'Create your account' : 'Welcome back';
  byId('authIntro').textContent = registering ? 'Set up your RELAY workspace account.' : 'Sign in to continue where your team left off.';
  byId('loginBtnLabel').textContent = registering ? 'Create account' : 'Sign in';
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
  const { endpoint, payload } = createAuthRequest(state.authMode, {
    email: byId('authEmail').value,
    password: byId('authPass').value,
    name: byId('authName').value,
  });
  if (registering && !isRegistrationPasswordValid(payload.password)) {
    errorEl.textContent = 'Use a password with at least 8 characters.';
    errorEl.classList.remove('hidden');
    return;
  }
  state.busy = true;
  const attempt = ++authGeneration;
  const button = byId('loginBtn');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  byId('loginBtnLabel').textContent = registering ? 'Creating account…' : 'Signing in…';
  const buttonIcon = button.querySelector('[data-lucide]');
  if (buttonIcon) buttonIcon.setAttribute('data-lucide', 'loader-circle');
  window.lucide?.createIcons();
  try {
    const data = await api(endpoint, { method: 'POST', body: JSON.stringify(payload) });
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
    button.removeAttribute('aria-busy');
    byId('loginBtnLabel').textContent = registering ? 'Create account' : 'Sign in';
    const icon = button.querySelector('[data-lucide]');
    if (icon) icon.setAttribute('data-lucide', 'arrow-right');
    window.lucide?.createIcons();
  }
}

function logout() { expireSession(); }
function togglePass() {
  const input = byId('authPass');
  input.type = input.type === 'password' ? 'text' : 'password';
  const visible = input.type === 'text';
  const button = byId('togglePassButton');
  button?.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  button?.setAttribute('aria-pressed', String(visible));
  const icon = button?.querySelector('[data-lucide]');
  if (icon) icon.setAttribute('data-lucide', visible ? 'eye-off' : 'eye');
  window.lucide?.createIcons();
}
function toggleSidebar() {
  const sidebar = byId('sidebar');
  const open = sidebar.classList.contains('-translate-x-full');
  sidebar.classList.toggle('-translate-x-full', !open);
  byId('sidebarBackdrop')?.classList.toggle('hidden', !open);
  byId('mobileNavToggle')?.setAttribute('aria-expanded', String(open));
}
function toggleDesktopSidebar() {
  const collapsed = byId('app')?.classList.toggle('sidebar-collapsed');
  const button = byId('desktopSidebarToggle');
  button?.setAttribute('aria-expanded', String(!collapsed));
  button?.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  const icon = button?.querySelector('[data-lucide]');
  if (icon) icon.setAttribute('data-lucide', collapsed ? 'panel-left-open' : 'panel-left-close');
  window.lucide?.createIcons();
}

function bindAuthMotion() {
  const scene = byId('authWorkflowScene');
  if (!scene || !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches || window.matchMedia('(pointer: coarse)').matches) return;
  let frame = 0;
  scene.addEventListener('pointermove', (event) => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      const bounds = scene.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - 0.5;
      const y = (event.clientY - bounds.top) / bounds.height - 0.5;
      scene.style.setProperty('--scene-tilt-x', `${(-y * 4).toFixed(2)}deg`);
      scene.style.setProperty('--scene-tilt-y', `${(x * 5).toFixed(2)}deg`);
      scene.style.setProperty('--scene-shift-x', `${(x * 8).toFixed(1)}px`);
      scene.style.setProperty('--scene-shift-y', `${(y * 6).toFixed(1)}px`);
      frame = 0;
    });
  });
  scene.addEventListener('pointerleave', () => {
    scene.style.setProperty('--scene-tilt-x', '0deg');
    scene.style.setProperty('--scene-tilt-y', '0deg');
    scene.style.setProperty('--scene-shift-x', '0px');
    scene.style.setProperty('--scene-shift-y', '0px');
  });
}

function consumeGitHubCallback() {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('github');
  const projectId = params.get('projectId');
  if (!['authorized', 'no_installations', 'cancelled', 'failed'].includes(outcome) || !/^[a-f\d]{24}$/i.test(projectId || '')) return null;
  window.history.replaceState({}, '', `${window.location.pathname}${window.location.hash}`);
  return { outcome, projectId };
}

function githubCallbackMessage(outcome) {
  return ({
    authorized: 'GitHub authorization succeeded. Choose an installation and explicitly link a repository below.',
    no_installations: 'GitHub authorization succeeded, but no active RELAY App installation was found. Install the RELAY GitHub App first.',
    cancelled: 'GitHub authorization was cancelled. No installation was linked.',
    failed: 'GitHub authorization could not be completed. No repository was linked.',
  })[outcome] || '';
}

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
    const callback = consumeGitHubCallback();
    if (callback) {
      state.githubNotice = githubCallbackMessage(callback.outcome);
      state.githubCallbackProjectId = callback.projectId;
    }
    refreshProjectControls();
    renderProjects();
    renderProjectSelector();
    renderDashboard();
    if (!state.projects.length) {
      state.selectedProjectId = '';
      state.sources = [];
      state.findings = [];
      state.githubInstallations = [];
      state.githubAvailableRepositories = [];
      state.githubDiscoveryInstallationId = '';
      state.errors.sources = '';
      state.errors.findings = '';
      renderSources(); renderFindings(); renderReview();
      return;
    }
    if (state.githubCallbackProjectId && state.projects.some((project) => String(project._id) === state.githubCallbackProjectId)) state.selectedProjectId = state.githubCallbackProjectId;
    if (!state.projects.some((project) => project._id === state.selectedProjectId)) state.selectedProjectId = state.projects[0]._id;
    select.value = state.selectedProjectId;
    await loadProjectData();
    if (callback) {
      navigate('sources');
      toast(state.githubNotice, callback.outcome === 'authorized' ? 'success' : 'error');
      state.githubCallbackProjectId = '';
      renderGitHubRepositories();
    }
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
  stopGitHubPolling();
  handoverRequest += 1;
  state.selectedProjectId = projectId;
  state.handovers = [];
  state.selectedHandoverId = '';
  state.handoverError = '';
  state.handoverActionError = '';
  state.handoverSignoffs = {};
  state.handoverSignoffError = '';
  state.contradictions = [];
  state.contradictionError = '';
  state.contradictionHistory = {};
  state.projectDeletion = null;
  state.projectDeletionError = '';
  state.analysisJob = null;
  state.analysisJobError = '';
  state.githubRepositories = [];
  state.githubInstallations = [];
  state.githubAvailableRepositories = [];
  state.githubDiscoveryInstallationId = '';
  state.githubDiscoveryLoading = false;
  state.githubDiscoveryError = '';
  state.githubNotice = '';
  state.githubError = '';
  state.githubLoading = false;
  state.githubBusyLinkId = '';
  state.githubRetryingJobId = '';
  state.sourceRevisionCache = {};
  state.analysisSelection = new Set();
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
    stopGitHubPolling();
    state.sources = [];
    state.findings = [];
    state.assignments = [];
    state.assignmentError = '';
    state.contradictions = [];
    state.contradictionError = '';
    state.errors.sources = '';
    state.errors.findings = '';
    state.analysisJob = null;
    state.analysisJobError = '';
    state.githubRepositories = [];
    state.githubInstallations = [];
    state.githubAvailableRepositories = [];
    state.githubDiscoveryInstallationId = '';
    state.githubError = '';
    renderAnalysisJob();
    renderSources(); renderFindings(); renderReview();
    return;
  }
  if (state.mode === 'demo') {
    stopGitHubPolling();
    state.errors.sources = '';
    state.errors.findings = '';
    state.assignments = [];
    state.assignmentError = '';
    state.contradictions = [];
    state.contradictionError = '';
    state.analysisJob = null;
    state.analysisJobError = '';
    state.githubRepositories = [];
    state.githubInstallations = [];
    state.githubAvailableRepositories = [];
    state.githubDiscoveryInstallationId = '';
    state.githubError = '';
    renderAnalysisJob();
    renderSources(); renderFindings(); renderReview(); renderProjects(); renderDashboard();
    return;
  }
  setStatus(byId('sourcesList'), 'Loading sources…', 'loading');
  setStatus(byId('findingsGrid'), 'Loading findings…', 'loading');
  setStatus(byId('reviewList'), 'Loading review queue…', 'loading');
  state.githubLoading = true;
  renderGitHubRepositories();
  const id = encodeURIComponent(state.selectedProjectId);
  const results = await Promise.allSettled([
    api(`/projects/${id}/sources`),
    api(`/projects/${id}/findings`),
    api(`/projects/${id}/assignments`),
    api(`/projects/${id}/github/repositories`),
    isCurrentProjectOwner(currentProject(), state.user?.id) ? api(`/projects/${id}/github/installations`) : Promise.resolve({ installations: [] }),
    api(`/projects/${id}/contradictions`),
    api(`/projects/${id}/handovers`),
  ]);
  if (results[0].status === 'fulfilled') { state.sources = results[0].value.sources || []; state.errors.sources = ''; }
  else { state.sources = []; state.errors.sources = results[0].reason.message; }
  if (results[1].status === 'fulfilled') { state.findings = results[1].value.findings || []; state.errors.findings = ''; }
  else { state.findings = []; state.errors.findings = results[1].reason.message; }
  if (results[2].status === 'fulfilled') { state.assignments = results[2].value.assignments || []; state.assignmentError = ''; }
  else { state.assignments = []; state.assignmentError = results[2].reason.message; }
  if (results[3].status === 'fulfilled') { state.githubRepositories = results[3].value.repositories || []; state.githubError = ''; }
  else { state.githubRepositories = []; state.githubError = results[3].reason.message; }
  state.githubInstallations = results[4].status === 'fulfilled' ? results[4].value.installations || [] : [];
  if (results[5].status === 'fulfilled') { state.contradictions = results[5].value.candidates || []; state.contradictionError = ''; }
  else { state.contradictions = []; state.contradictionError = results[5].reason.message; }
  if (results[6].status === 'fulfilled') state.handovers = results[6].value.handovers || [];
  else state.handovers = [];
  state.handoverError = results[6].status === 'rejected' ? results[6].reason.message : '';
  state.dashboardAuditEvents = []; state.dashboardAuditError = '';
  if (canReadProjectAudit()) {
    try { state.dashboardAuditEvents = (await api(`/projects/${id}/audit-events?limit=5`)).events || []; }
    catch (error) { state.dashboardAuditError = error.message; }
  }
  state.githubLoading = false;
  const currentSourceIds = new Set(state.sources.filter((source) => source.status === 'processed').map((source) => String(source._id)));
  state.analysisSelection = new Set([...state.analysisSelection].filter((sourceId) => currentSourceIds.has(sourceId)));
  refreshProjectControls();
  renderSources(); renderFindings(); renderReview(); renderProjects(); renderGitHubRepositories();
  renderDashboard();
  await loadAnalysisJob({ resume: true });
  resumeGitHubPolling();
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
    const card = node('button', undefined, 'project-card glass rounded-2xl p-5 card-hover cursor-pointer text-left w-full');
    card.type = 'button';
    const deletion = projectDeletionCardPresentation(project);
    const deletionState = deletion.state;
    const isRecoverable = deletion.recoverable;
    card.setAttribute('aria-label', `${project.name}, ${deletionState === 'active' ? project.status || 'active' : `project ${deletionState}`}${isRecoverable ? ', recovery available in project settings' : ''}`);
    card.addEventListener('click', () => { selectProject(project._id); navigate(deletion.destination); });
    const top = node('div', undefined, 'flex items-center justify-between');
    const badgeText = deletion.label;
    const badge = node('span', badgeText, `text-[11px] font-mono tracking-widest px-2.5 py-1 rounded-full ${deletionState === 'active' ? 'bg-emerald-500 text-white' : 'bg-amber-500/20 text-amber-100'}`);
    const updated = node('span', project.updatedAt ? new Date(project.updatedAt).toLocaleDateString() : '', 'text-xs text-white/40');
    const role = state.mode === 'demo' ? 'DEMO' : String(project.owner) === String(state.user?.id) ? 'OWNER' : ((project.members || []).find((member) => String(member.user?._id || member.user) === String(state.user?.id))?.role || 'MEMBER').toUpperCase();
    top.append(badge, node('span', role, 'text-[10px] font-mono tracking-wider text-violet-200 bg-violet-500/15 px-2 py-1 rounded-full'), updated);
    const title = node('h3', project.name, 'text-white font-semibold mt-3');
    const description = node('p', project.description || 'No description provided.', 'text-white/40 text-sm mt-1 line-clamp-2');
    card.append(top, title, description);
    const cardMetrics = projectCardMetrics(project, { selected: String(project._id) === String(state.selectedProjectId), sources: state.sources, findings: state.findings, sourcesUnavailable: Boolean(state.errors.sources), findingsUnavailable: Boolean(state.errors.findings) });
    const meta = node('div', undefined, 'mt-3 flex flex-wrap gap-2');
    const people = node('div', undefined, 'flex items-center -space-x-2');
    const memberUsers = (project.members || []).map((member) => member.user).filter((user) => user && typeof user === 'object');
    const isOwner = String(project.owner) === String(state.user?.id);
    const isMember = (project.members || []).some((member) => String(member.user?._id || member.user) === String(state.user?.id));
    if ((isOwner || isMember) && state.user) memberUsers.unshift(state.user);
    memberUsers.slice(0, 4).forEach((person) => {
      const initials = (person.name || person.email || 'Member').split(/[\s@]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
      const avatar = node('span', initials, 'grid h-8 w-8 place-items-center rounded-full border-2 border-white bg-indigo-50 text-[10px] font-semibold text-indigo-700');
      avatar.title = person.name || person.email || 'Project member';
      people.append(avatar);
    });
    if (people.childElementCount) meta.append(people);
    meta.append(node('span', `${cardMetrics.teamMembers} team member${cardMetrics.teamMembers === 1 ? '' : 's'}`, 'self-center text-xs text-white/45'));
    if (String(project._id) === String(state.selectedProjectId)) {
      meta.append(node('span', cardMetrics.sources === null ? 'Sources unavailable' : `${cardMetrics.sources} source(s)`, 'rounded-lg bg-white/5 px-2.5 py-1.5 text-xs text-white/60'));
      meta.append(node('span', cardMetrics.findings === null ? 'Findings unavailable' : `${cardMetrics.findings} finding(s)`, 'rounded-lg bg-white/5 px-2.5 py-1.5 text-xs text-white/60'));
      meta.append(node('span', cardMetrics.pending === null ? 'Review count unavailable' : `${cardMetrics.pending} pending review`, 'rounded-lg bg-amber-500/15 px-2.5 py-1.5 text-xs text-amber-200'));
    } else meta.append(node('span', 'Open for project metrics', 'rounded-lg bg-white/5 px-2.5 py-1.5 text-xs text-white/45'));
    card.append(meta);
    if (deletion.recoveryEndsAt) card.append(node('p', `Recovery deadline ${deletion.recoveryEndsAt.toLocaleString()}`, 'mt-3 text-xs text-amber-100/70'));
    card.append(node('p', isRecoverable ? 'Open project settings to recover →' : deletionState === 'active' ? 'Open project →' : 'View project cleanup status →', 'mt-4 text-xs text-violet-300'));
    container.append(card);
  });
}

async function openCreateProject() {
  const [name] = await accessibleFormDialog({ title: 'Create a project', description: 'Start a workspace for source material, review, and handover.', fields: [{ type: 'text', label: 'Project name', required: true, maxLength: 100, placeholder: 'e.g. Platform migration' }], submitLabel: 'Create project' }) || [];
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
  renderGitHubRepositories();
  clear(container);
  if (state.errors.sources) { setStatus(container, `Could not load sources: ${state.errors.sources}`, 'error'); return; }
  if (!state.selectedProjectId) { setStatus(container, 'Select or create a project before uploading sources.'); return; }
  if (!state.sources.length) { setStatus(container, 'No sources in this project yet. Upload a document to get started.'); return; }
  const filter = byId('sourceFilter')?.value || 'all';
  const sources = state.sources.filter((source) => filter === 'all' || statusLabel(source.status) === filter);
  if (!sources.length) { setStatus(container, state.sources.length ? 'No sources match this status.' : 'No sources in this project yet. Upload a document to get started.'); return; }
  sources.forEach((source) => {
    const card = node('div', undefined, `source-card glass rounded-2xl p-4 flex gap-4 ${source.provider === 'github' ? 'source-card-github' : ''}`);
    const imported = source.provider === 'github';
    const ext = imported ? String(source.externalType || 'github').toUpperCase() : source.originalName?.split('.').pop()?.toUpperCase() || 'FILE';
    card.append(node('div', ext, 'w-11 h-11 rounded-xl bg-violet-500/20 text-violet-400 flex items-center justify-center shrink-0 font-mono text-xs font-bold'));
    const content = node('div', undefined, 'flex-1 min-w-0');
    content.append(node('p', source.originalName, 'text-white text-sm font-medium truncate'));
    content.append(node('p', `${imported ? 'GitHub import · ' : ''}${statusLabel(source.status)}${source.size ? ` · ${(source.size / 1024).toFixed(1)} KB` : ''}`, 'text-white/40 text-xs mt-1'));
    if (imported) {
      const repository = state.githubRepositories.find((item) => String(item.id) === String(source.repositoryLink));
      content.append(node('p', `From ${repository?.fullName || 'linked GitHub repository'}${source.externalType === 'issue' ? ` · Issue #${source.externalId}` : source.externalType === 'commit' ? ` · Commit ${String(source.externalId || '').slice(0, 12)}` : source.externalType === 'readme' ? ` · ${source.externalId || 'README'}` : ''}`, 'text-xs text-sky-200/80 mt-1 break-words'));
      if (source.currentRevision) content.append(node('p', `Current revision · ${String(source.currentRevision).slice(-8)}`, 'text-[10px] font-mono text-white/35 mt-1'));
      const revisionState = state.sourceRevisionCache[source._id];
      const latestRevision = revisionState?.revisions?.find((revision) => revision.isCurrent);
      if (latestRevision?.locator?.truncated) content.append(node('p', 'Content was truncated to the approved ingestion limit.', 'text-xs text-amber-200 mt-1'));
    }
    if (source.error) content.append(node('p', source.error, 'text-red-300 text-xs mt-2'));
    if (source.status === 'processed' && canManageCurrentProject()) {
      const selectLabel = node('label', undefined, 'mt-3 flex items-center gap-2 text-xs text-white/55 cursor-pointer');
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = state.analysisSelection.has(String(source._id));
      checkbox.setAttribute('aria-label', `Select ${source.originalName} for explicit AI analysis`);
      checkbox.addEventListener('change', () => {
        const selected = new Set(state.analysisSelection);
        if (checkbox.checked) selected.add(String(source._id)); else selected.delete(String(source._id));
        state.analysisSelection = selected;
        renderAnalysisSelectionCount();
      });
      selectLabel.append(checkbox, node('span', 'Include in next explicit analysis'));
      content.append(selectLabel);
    }
    const actions = node('div', undefined, 'mt-3 flex flex-wrap gap-2');
    if (imported) {
      const view = node('button', 'View captured text', 'rounded-full bg-white/10 px-3 py-1.5 text-[11px] text-white/75 hover:bg-white/15');
      view.type = 'button';
      view.addEventListener('click', () => toggleGitHubSourceText(source, actions));
      const history = node('button', 'Revision history', 'rounded-full bg-white/10 px-3 py-1.5 text-[11px] text-white/75 hover:bg-white/15');
      history.type = 'button';
      history.addEventListener('click', () => toggleGitHubRevisionHistory(source, actions));
      actions.append(view, history);
    }
    if (actions.childElementCount) content.append(actions);
    card.append(content);
    container.append(card);
  });
}

function renderAnalysisSelectionCount() {
  const count = state.analysisSelection.size;
  for (const id of ['analyzeTopButton', 'analyzeFindingsButton']) {
    const label = byId(id)?.querySelector('span');
    if (label && (!state.analysisJob || state.analysisJob.status === 'completed')) label.textContent = count ? `Analyze ${count} Selected` : 'Analyze New Sources';
  }
}

function renderGitHubRepositories() {
  const container = byId('githubRepositories');
  const panel = byId('githubRepositoriesPanel');
  if (!container || !panel) return;
  panel.classList.toggle('hidden', state.mode === 'demo');
  clear(container);
  if (state.mode === 'demo') return;
  if (!state.selectedProjectId) { setStatus(container, 'Select a project to view linked repositories.'); return; }
  if (state.githubLoading) { setStatus(container, 'Loading linked GitHub repositories…', 'loading'); return; }
  if (state.githubError) {
    const retry = node('button', `Could not load GitHub connections: ${state.githubError} · Retry`, 'w-full rounded-xl border border-rose-300/20 bg-rose-500/10 px-3 py-3 text-left text-xs text-rose-200');
    retry.type = 'button'; retry.addEventListener('click', loadGitHubRepositories);
    container.append(retry); return;
  }
  if (state.githubNotice) {
    const tone = state.githubNotice.startsWith('GitHub authorization succeeded') ? 'border-emerald-300/15 bg-emerald-500/10 text-emerald-100' : 'border-amber-300/15 bg-amber-500/10 text-amber-100';
    container.append(node('p', state.githubNotice, `rounded-xl border px-3 py-2 text-xs ${tone}`));
  }
  if (isCurrentProjectOwner(currentProject(), state.user?.id)) renderGitHubLinkingControls(container);
  if (!state.githubRepositories.length) {
    const empty = node('div', undefined, 'rounded-xl border border-white/5 bg-white/[0.02] p-3');
    empty.append(node('p', 'No GitHub repositories are linked to this project.', 'text-xs text-white/55'));
    container.append(empty);
  }
  state.githubRepositories.forEach((repository) => {
    const row = node('article', undefined, 'repository-card rounded-xl border border-white/5 bg-white/[0.025] p-3 sm:p-4');
    const top = node('div', undefined, 'flex flex-wrap items-start justify-between gap-3');
    const identity = node('div', undefined, 'min-w-0 flex-1');
    const name = node('p', repository.fullName || `${repository.ownerLogin}/${repository.name}`, 'break-all text-sm font-semibold text-white');
    const status = githubConnectionLabel(repository);
    const statusStyle = status === 'Connected' ? 'text-emerald-200 bg-emerald-500/10' : status === 'Unlinked' ? 'text-white/45 bg-white/5' : 'text-amber-200 bg-amber-500/10';
    const badge = node('span', status, `rounded-full px-2.5 py-1 text-[10px] font-mono ${statusStyle}`);
    identity.append(name, node('p', `${repository.installation?.accountLogin ? `GitHub account · ${repository.installation.accountLogin}` : 'GitHub App installation'}${repository.installation?.lastVerifiedAt ? ` · verified ${new Date(repository.installation.lastVerifiedAt).toLocaleString()}` : ''}`, 'mt-1 text-[11px] text-white/40 break-words'));
    top.append(identity, badge); row.append(top);
    if (repository.status === 'unlinked') row.append(node('p', `Unlinked ${repository.unlinkedAt ? new Date(repository.unlinkedAt).toLocaleString() : ''} · imported sources and revision provenance are retained.`, 'mt-2 text-xs text-white/40'));
    else if (repository.connectionStatus === 'needs_reauthorization') row.append(node('p', 'GitHub access is suspended or removed. The project owner must authorize the installation again.', 'mt-2 text-xs text-amber-200/80'));
    else if (repository.connectionStatus === 'needs_verification') row.append(node('p', 'The saved installation status is stale. Sync will verify repository access before importing.', 'mt-2 text-xs text-amber-100/70'));

    const job = repository.latestSyncJob;
    if (job) {
      const statusText = githubSyncStatusLabel(job);
      const progress = node('div', undefined, 'mt-3 rounded-lg border border-white/5 bg-black/15 p-3');
      const line = node('div', undefined, 'flex flex-wrap items-center justify-between gap-2');
      line.append(node('p', `${statusText} · ${githubSyncStageLabel(job.stage)}`, 'text-xs font-medium text-white/80'));
      if (job.startedAt) line.append(node('p', new Date(job.startedAt).toLocaleString(), 'text-[10px] text-white/35'));
      progress.append(line);
      const counts = job.counts || {};
      progress.append(node('p', `${job.checkpoints?.readme?.status === 'completed' ? 'README captured' : job.checkpoints?.readme?.status === 'skipped' ? 'README missing' : 'README pending'} · ${counts.commitsCaptured || 0} commits · ${counts.issuesCaptured || 0} issues · ${counts.sourcesCreated || 0} sources created · ${counts.revisionsCreated || 0} new or updated revisions · ${counts.revisionsReused || 0} unchanged revisions${counts.pullRequestsSkipped ? ` · ${counts.pullRequestsSkipped} pull requests skipped` : ''}`, 'mt-2 text-[11px] text-white/45 break-words'));
      if (job.resultCompleteness === 'partial' || job.status === 'partial') {
        const reason = job.checkpoints?.issues?.partialReason === 'issue_scan_limit_reached'
          ? `Issue scan limit reached; ${counts.issuesCaptured || 0} issues were captured.`
          : 'This sync is partial. Completed content is retained; retry is available when permitted.';
        progress.append(node('p', reason, 'mt-2 text-xs text-amber-200'));
      }
      if (job.lastErrorCode) progress.append(node('p', githubSyncErrorMessage(job.lastErrorCode), 'mt-2 text-xs text-rose-200/80'));
      if (job.retryAt && new Date(job.retryAt).getTime() > Date.now()) progress.append(node('p', `Retry available after ${new Date(job.retryAt).toLocaleTimeString()}.`, 'mt-2 text-[11px] text-amber-100/70'));
      row.append(progress);
    }

    const activeJob = job && ['running', 'partial', 'retry_wait', 'interrupted'].includes(job.status);
    const actions = node('div', undefined, 'mt-3 flex flex-wrap items-center gap-2');
    if (isProjectOwner(currentProject(), state.user?.id)) {
      if (repository.connectionStatus === 'needs_reauthorization') {
        const authorize = node('button', 'Reauthorize GitHub', 'rounded-full bg-amber-500/15 px-3 py-1.5 text-xs text-amber-100 hover:bg-amber-500/25');
        authorize.type = 'button'; authorize.disabled = Boolean(state.githubBusyLinkId);
        authorize.addEventListener('click', beginGitHubAuthorization); actions.append(authorize);
      }
      const retryable = canRetryGitHubSync(repository, currentProject(), state.user?.id);
      if (retryable) {
        const retry = node('button', state.githubRetryingJobId === job?.id ? 'Retrying…' : 'Retry sync', 'rounded-full bg-amber-500/15 px-3 py-1.5 text-xs text-amber-100 hover:bg-amber-500/25 disabled:opacity-50');
        retry.type = 'button'; retry.disabled = Boolean(state.githubRetryingJobId || state.githubBusyLinkId);
        retry.addEventListener('click', () => retryGitHubSync(repository)); actions.append(retry);
      }
      if (canSyncGitHubRepository(repository, currentProject(), state.user?.id) && !activeJob) {
        const sync = createGitHubActionButton(document, state.githubBusyLinkId === repository.id ? 'Syncing…' : job?.status === 'completed' ? 'Sync again' : 'Sync GitHub', 'rounded-full bg-sky-500/15 px-3 py-1.5 text-xs text-sky-100 hover:bg-sky-500/25 disabled:opacity-50');
        sync.disabled = Boolean(state.githubBusyLinkId || state.githubRetryingJobId);
        sync.addEventListener('click', () => startGitHubSync(repository)); actions.append(sync);
      }
    }
    if (job?.status === 'running') {
      const refresh = node('button', githubPollCount >= 16 ? 'Refresh status' : 'Refresh now', 'rounded-full bg-white/5 px-3 py-1.5 text-[10px] text-white/55 hover:bg-white/10');
      refresh.type = 'button'; refresh.addEventListener('click', refreshGitHubStatus); actions.append(refresh);
      actions.append(node('span', githubPollCount >= 16 ? 'Automatic refresh paused; saved status remains available.' : 'Status refreshes automatically for a short period.', 'text-[10px] text-white/35'));
    }
    row.append(actions);
    container.append(row);
  });
  if (window.lucide) window.lucide.createIcons();
}

function renderGitHubLinkingControls(container) {
  const controls = node('section', undefined, 'rounded-xl border border-sky-300/10 bg-sky-500/[0.04] p-3 sm:p-4');
  controls.append(node('p', 'Connect a GitHub installation and choose repositories to link to this project. Linking is always explicit.', 'text-xs text-white/55'));
  const actions = node('div', undefined, 'mt-3 flex flex-wrap gap-2');
  const connect = node('button', 'Connect existing installation', 'rounded-full bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/15 disabled:opacity-50');
  connect.type = 'button'; connect.disabled = Boolean(state.githubAuthorizing);
  connect.addEventListener('click', beginGitHubAuthorization);
  actions.append(connect);
  const hasActiveInstallation = state.githubInstallations.some((item) => item.status === 'active' || (item.status === 'unverified' && item.lastKnownStatus === 'active'));
  if (!hasActiveInstallation) {
    const install = node('button', 'Install RELAY GitHub App', 'rounded-full bg-violet-500/15 px-3 py-1.5 text-xs text-violet-100 hover:bg-violet-500/25 disabled:opacity-50');
    install.type = 'button'; install.disabled = Boolean(state.githubAuthorizing);
    install.addEventListener('click', beginGitHubInstallation);
    actions.append(install);
    controls.append(actions, node('p', 'Use installation to install, restore, or update the RELAY GitHub App. GitHub may open its installation settings when this account already has an installation.', 'mt-2 text-[10px] text-white/35'));
    if (!state.githubInstallations.length) { container.append(controls); return; }
  }
  if (hasActiveInstallation) controls.append(actions);
  const installations = node('div', undefined, 'mt-3 space-y-2');
  state.githubInstallations.forEach((installation) => {
    const item = node('div', undefined, 'flex flex-col gap-2 rounded-lg border border-white/5 bg-black/10 p-3 sm:flex-row sm:items-center');
    const info = node('div', undefined, 'min-w-0 flex-1');
    info.append(node('p', installation.accountLogin || 'GitHub account', 'text-xs font-medium text-white/80'), node('p', `${installation.accountType || 'GitHub App installation'} · ${githubInstallationStatusLabel(installation)}`, 'mt-1 text-[10px] text-white/40'));
    const discover = node('button', state.githubDiscoveryLoading && state.githubDiscoveryInstallationId === installation.id ? 'Loading repositories…' : 'Discover repositories', 'rounded-full bg-sky-500/15 px-3 py-1.5 text-xs text-sky-100 hover:bg-sky-500/25 disabled:opacity-50');
    discover.type = 'button'; discover.disabled = Boolean(state.githubDiscoveryLoading);
    discover.addEventListener('click', () => discoverGitHubRepositories(installation.id));
    item.append(info, discover); installations.append(item);
  });
  controls.append(installations);
  if (state.githubDiscoveryInstallationId) {
    const selected = state.githubInstallations.find((item) => item.id === state.githubDiscoveryInstallationId);
    controls.append(node('p', `Repositories available to ${selected?.accountLogin || 'selected installation'}:`, 'mt-3 text-xs text-white/65'));
    if (state.githubDiscoveryLoading) controls.append(node('p', 'Loading repository list…', 'mt-2 text-xs text-white/40'));
    else if (state.githubDiscoveryError) controls.append(node('p', `Could not discover repositories: ${state.githubDiscoveryError}`, 'mt-2 text-xs text-rose-200'));
    else if (!state.githubAvailableRepositories.length) controls.append(node('p', 'No repositories are available to this installation.', 'mt-2 text-xs text-white/40'));
    const repoList = node('div', undefined, 'mt-2 space-y-2');
    state.githubAvailableRepositories.forEach((repository) => {
      const linked = state.githubRepositories.some((item) => String(item.repositoryId) === String(repository.repositoryId) && item.status === 'active');
      const row = node('div', undefined, 'flex flex-col gap-2 rounded-lg border border-white/5 bg-black/10 p-3 sm:flex-row sm:items-center');
      row.append(node('div', `${repository.fullName} · ${repository.private ? 'Private' : 'Public'}`, 'min-w-0 flex-1 break-all text-xs text-white/75'));
      const link = node('button', linked ? 'Already linked' : state.githubLinkingRepositoryId === repository.repositoryId ? 'Linking…' : 'Link repository', 'rounded-full bg-emerald-500/15 px-3 py-1.5 text-xs text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-50');
      link.type = 'button'; link.disabled = linked || Boolean(state.githubLinkingRepositoryId || state.githubDiscoveryLoading);
      link.addEventListener('click', () => linkGitHubRepository(state.githubDiscoveryInstallationId, repository));
      row.append(link); repoList.append(row);
    });
    controls.append(repoList);
  }
  container.append(controls);
}

async function loadGitHubRepositories() {
  const projectId = state.selectedProjectId;
  if (!projectId || state.mode !== 'real') return;
  state.githubLoading = true; state.githubError = '';
  renderGitHubRepositories();
  try {
    const result = await api(`/projects/${encodeURIComponent(projectId)}/github/repositories`);
    if (state.selectedProjectId !== projectId) return;
    state.githubRepositories = result.repositories || [];
    state.githubError = '';
    renderGitHubRepositories();
    resumeGitHubPolling();
  } catch (error) {
    if (state.selectedProjectId === projectId) { state.githubError = error.message; renderGitHubRepositories(); }
  } finally {
    if (state.selectedProjectId === projectId) { state.githubLoading = false; renderGitHubRepositories(); }
  }
}

async function refreshGitHubStatus() {
  stopGitHubPolling();
  await loadGitHubRepositories();
}

function resumeGitHubPolling() {
  if (state.mode !== 'real' || !state.selectedProjectId || githubPollTimer) return;
  const running = state.githubRepositories.filter((repository) => repository.latestSyncJob?.status === 'running');
  if (!running.length || githubPollCount >= 16) return;
  const generation = githubPollGeneration;
  const projectId = state.selectedProjectId;
  githubPollTimer = window.setTimeout(async () => {
    githubPollTimer = null;
    if (generation !== githubPollGeneration || projectId !== state.selectedProjectId) return;
    const controller = new AbortController(); githubPollController = controller;
    await Promise.all(running.map(async (repository) => {
      const jobId = repository.latestSyncJob.id;
      try {
        const result = await api(`/projects/${encodeURIComponent(projectId)}/github/sync-jobs/${encodeURIComponent(jobId)}`, { signal: controller.signal });
        if (generation !== githubPollGeneration || projectId !== state.selectedProjectId) return;
        const target = state.githubRepositories.find((item) => item.id === repository.id);
        if (target && target.latestSyncJob?.id === jobId) target.latestSyncJob = result.job;
      } catch (error) {
        if (error.name !== 'AbortError' && generation === githubPollGeneration) console.info('[RELAY GITHUB STATUS]', { status: error.status || 'network-error' });
      }
    }));
    if (generation !== githubPollGeneration) return;
    githubPollController = null; githubPollCount += 1;
    renderGitHubRepositories();
    if (!state.githubRepositories.some((repository) => repository.latestSyncJob?.status === 'running')) {
      // Refresh source metadata after terminal completion, partial completion or failure.
      loadGitHubRepositories();
      api(`/projects/${encodeURIComponent(projectId)}/sources`).then((data) => {
        if (projectId === state.selectedProjectId) { state.sources = data.sources || []; renderSources(); }
      }).catch(() => {});
      return;
    }
    resumeGitHubPolling();
  }, 2500);
}

async function startGitHubSync(repository) {
  if (!canSyncGitHubRepository(repository, currentProject(), state.user?.id) || state.githubBusyLinkId || state.githubRetryingJobId) return;
  const projectId = state.selectedProjectId;
  state.githubBusyLinkId = repository.id; renderGitHubRepositories();
  try {
    let settled = false;
    const request = api(`/projects/${encodeURIComponent(projectId)}/github/repositories/${encodeURIComponent(repository.id)}/sync`, { method: 'POST', body: '{}' })
      .then((value) => { settled = true; return value; }, (error) => { settled = true; throw error; });
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    if (!settled && projectId === state.selectedProjectId) await loadGitHubRepositories();
    const result = await request;
    if (projectId !== state.selectedProjectId) return;
    repository.latestSyncJob = result.job;
    state.githubBusyLinkId = '';
    renderGitHubRepositories();
    if (result.job.status === 'running') { toast('GitHub sync is running. You can leave and return to recover its status.'); resumeGitHubPolling(); }
    else toast(githubSyncStatusLabel(result.job) === 'Partial' ? 'GitHub sync completed with partial coverage.' : 'GitHub sync completed. AI analysis was not started.');
    const sources = await api(`/projects/${encodeURIComponent(projectId)}/sources`);
    if (projectId === state.selectedProjectId) { state.sources = sources.sources || []; renderSources(); }
    await loadGitHubRepositories();
  } catch (error) {
    if (projectId === state.selectedProjectId) {
      state.githubBusyLinkId = '';
      toast(error.status === 409 ? 'A sync is already active or this repository is no longer available.' : githubSyncErrorMessage(error.code), 'error');
      renderGitHubRepositories();
    }
  }
}

async function retryGitHubSync(repository) {
  if (!canRetryGitHubSync(repository, currentProject(), state.user?.id) || state.githubRetryingJobId || state.githubBusyLinkId) return;
  const projectId = state.selectedProjectId; const jobId = repository.latestSyncJob.id;
  state.githubRetryingJobId = jobId; renderGitHubRepositories();
  try {
    let settled = false;
    const request = api(`/projects/${encodeURIComponent(projectId)}/github/sync-jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST', body: '{}' })
      .then((value) => { settled = true; return value; }, (error) => { settled = true; throw error; });
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    if (!settled && projectId === state.selectedProjectId) await loadGitHubRepositories();
    const result = await request;
    if (projectId !== state.selectedProjectId) return;
    repository.latestSyncJob = result.job;
    state.githubRetryingJobId = '';
    renderGitHubRepositories();
    if (result.job.status === 'running') { toast('GitHub sync retry is running.'); resumeGitHubPolling(); }
    else toast(githubSyncStatusLabel(result.job) === 'Partial' ? 'GitHub sync remains partial.' : 'GitHub sync retry completed.');
    await loadGitHubRepositories();
  } catch (error) {
    if (projectId === state.selectedProjectId) {
      state.githubRetryingJobId = '';
      toast(error.status === 409 ? 'This sync is not ready to retry. Refresh its status.' : githubSyncErrorMessage(error.code), 'error');
      renderGitHubRepositories();
    }
  }
}

async function beginGitHubAuthorization() {
  if (!isCurrentProjectOwner(currentProject(), state.user?.id) || state.mode !== 'real' || state.githubAuthorizing) return;
  state.githubAuthorizing = true; renderGitHubRepositories();
  try {
    const result = await api(`/projects/${encodeURIComponent(state.selectedProjectId)}/github/installations/authorize`, { method: 'POST', body: '{}' });
    navigateToGitHub(result.authorizationUrl);
  } catch (error) { state.githubAuthorizing = false; renderGitHubRepositories(); toast(`Could not start GitHub authorization: ${error.message}`, 'error'); }
}

async function beginGitHubInstallation() {
  if (!isCurrentProjectOwner(currentProject(), state.user?.id) || state.mode !== 'real' || state.githubAuthorizing) return;
  state.githubAuthorizing = true; renderGitHubRepositories();
  try {
    const result = await api(`/projects/${encodeURIComponent(state.selectedProjectId)}/github/installations/start`, { method: 'POST', body: '{}' });
    navigateToGitHub(result.installationUrl);
  } catch (error) { state.githubAuthorizing = false; renderGitHubRepositories(); toast(`Could not start GitHub App installation: ${error.message}`, 'error'); }
}

function navigateToGitHub(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) throw new Error('GitHub returned an unsafe authorization URL.');
  window.location.assign(url.href);
}

async function discoverGitHubRepositories(installationId) {
  if (!isCurrentProjectOwner(currentProject(), state.user?.id) || state.githubDiscoveryLoading) return;
  const projectId = state.selectedProjectId;
  state.githubDiscoveryInstallationId = installationId;
  state.githubAvailableRepositories = [];
  state.githubDiscoveryError = '';
  state.githubDiscoveryLoading = true;
  try {
    renderGitHubRepositories();
    const result = await api(`/projects/${encodeURIComponent(projectId)}/github/repositories?installationId=${encodeURIComponent(installationId)}`);
    if (state.selectedProjectId !== projectId) return;
    if (!Array.isArray(result.repositories)) throw new Error('GitHub returned an invalid repository list.');
    state.githubAvailableRepositories = result.repositories;
  } catch (error) {
    if (state.selectedProjectId === projectId) state.githubDiscoveryError = error.message;
  } finally {
    if (state.selectedProjectId === projectId) { state.githubDiscoveryLoading = false; renderGitHubRepositories(); }
  }
}

async function linkGitHubRepository(installationId, repository) {
  if (!isCurrentProjectOwner(currentProject(), state.user?.id) || state.githubLinkingRepositoryId) return;
  const projectId = state.selectedProjectId;
  state.githubLinkingRepositoryId = String(repository.repositoryId);
  renderGitHubRepositories();
  try {
    await api(`/projects/${encodeURIComponent(projectId)}/github/repositories`, {
      method: 'POST', body: JSON.stringify({ installationId, repositoryId: repository.repositoryId }),
    });
    toast(`${repository.fullName} linked to this project.`);
    await loadProjectData();
    await discoverGitHubRepositories(installationId);
  } catch (error) {
    if (state.selectedProjectId === projectId) toast(error.status === 409 ? 'This repository is already linked to the project.' : `Could not link repository: ${error.message}`, 'error');
  } finally {
    state.githubLinkingRepositoryId = '';
    renderGitHubRepositories();
  }
}

async function toggleGitHubSourceText(source, actions) {
  const prior = actions.querySelector('[data-source-text]');
  if (prior) { prior.remove(); return; }
  const panel = node('div', 'Loading captured source text…', 'mt-3 w-full rounded-xl bg-black/20 p-3 text-xs text-white/45');
  panel.dataset.sourceText = 'true';
  actions.after(panel);
  const projectId = state.selectedProjectId;
  try {
    const data = await api(`/sources/${encodeURIComponent(source._id)}/content`);
    if (projectId !== state.selectedProjectId || !panel.isConnected) return;
    const pre = node('pre', data.source?.extractedText || 'No captured text is available.', 'max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-white/70');
    panel.replaceChildren(node('p', 'Captured GitHub text · displayed as plain text', 'mb-2 text-[10px] font-mono uppercase tracking-wider text-sky-200/70'), pre);
  } catch (error) {
    if (panel.isConnected) panel.textContent = `Could not load captured text: ${error.message}`;
  }
}

async function toggleGitHubRevisionHistory(source, actions) {
  const prior = actions.querySelector('[data-revision-history]');
  if (prior) { prior.remove(); return; }
  const panel = node('div', 'Loading revision history…', 'mt-3 w-full rounded-xl bg-black/20 p-3 text-xs text-white/45');
  panel.dataset.revisionHistory = 'true';
  actions.after(panel);
  const projectId = state.selectedProjectId;
  try {
    let data = state.sourceRevisionCache[source._id];
    if (!data) {
      data = await api(`/sources/${encodeURIComponent(source._id)}/revisions?limit=20`);
      state.sourceRevisionCache[source._id] = data;
    }
    if (projectId !== state.selectedProjectId || !panel.isConnected) return;
    clear(panel);
    panel.append(node('p', `${data.total} captured revision(s) · text snapshots remain immutable`, 'mb-2 text-[10px] font-mono uppercase tracking-wider text-sky-200/70'));
    if (!data.revisions?.length) panel.append(node('p', 'No revision metadata is available.', 'text-xs text-white/45'));
    (data.revisions || []).forEach((revision) => {
      const item = node('div', undefined, 'border-t border-white/5 py-2 first:border-0');
      item.append(node('p', `${revision.isCurrent ? 'CURRENT' : revision.isAnalyzed ? 'ANALYZED' : 'HISTORICAL'} · ${String(revision.revisionKey || revision._id).slice(0, 42)}`, 'font-mono text-[10px] text-white/65 break-all'));
      const locator = revision.locator || {};
      const provenance = [locator.repositoryFullName, locator.path, locator.issueNumber ? `Issue #${locator.issueNumber}` : '', locator.commitSha ? `Commit ${String(locator.commitSha).slice(0, 12)}` : ''].filter(Boolean).join(' · ');
      item.append(node('p', `${provenance || 'GitHub source'}${revision.capturedAt ? ` · captured ${new Date(revision.capturedAt).toLocaleString()}` : ''}`, 'mt-1 text-[11px] text-white/40 break-words'));
      if (locator.truncated) item.append(node('p', `Truncated · ${locator.contentBytes || 0} bytes stored from ${locator.originalBytes || 0} bytes`, 'mt-1 text-[10px] text-amber-200'));
      panel.append(item);
    });
  } catch (error) {
    if (panel.isConnected) panel.textContent = `Could not load revision history: ${error.message}`;
  }
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
    const card = node('article', undefined, 'finding-card glass rounded-2xl p-4 card-hover');
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
      if (evidence.sourceRevision) {
        const locator = evidence.locator || {};
        const origin = [locator.repositoryFullName, locator.path, locator.issueNumber ? `Issue #${locator.issueNumber}` : '', locator.commitSha ? `Commit ${String(locator.commitSha).slice(0, 12)}` : ''].filter(Boolean).join(' · ');
        card.append(node('p', `GitHub revision ${String(evidence.sourceRevision._id || evidence.sourceRevision).slice(-8)}${origin ? ` · ${origin}` : ''}`, 'mt-1 text-[10px] font-mono text-sky-200/60 break-words'));
      }
    });
    const evidenceButton = node('button', 'View evidence', 'mt-4 rounded-full bg-white/10 px-4 py-2 text-xs text-white hover:bg-white/15 transition');
    evidenceButton.type = 'button';
    evidenceButton.addEventListener('click', () => openEvidence(finding._id));
    card.append(evidenceButton);
    container.append(card);
  });
}

function renderReview() {
  renderContradictions();
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
    const row = node('article', undefined, 'review-card glass rounded-2xl p-4');
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
    } else if (!canReviewFindingInCurrentProject(finding)) {
      const assignedMode = currentProject()?.workflowPolicy?.reviewMode === 'assigned';
      const reason = state.assignmentError
        ? `Read-only · Could not verify workflow assignments: ${state.assignmentError}`
        : assignedMode
          ? 'Read-only · An active reviewer assignment for this finding is required.'
          : 'Read-only · Project owner or editor access is required to review findings.';
      actions.append(node('span', reason, 'text-xs text-white/40'));
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

function canReviewContradiction(candidate) {
  return canReviewContradictionForUser({ mode: state.mode, project: currentProject(), userId: state.user?.id, assignments: state.assignments, candidate });
}

function canReadProjectAudit() {
  return canReadProjectAuditForUser({ mode: state.mode, project: currentProject(), userId: state.user?.id, assignments: state.assignments });
}

function renderContradictions() {
  renderContradictionList('contradictionList', 'detectContradictionsButton');
  renderContradictionList('projectContradictionList', 'projectDetectContradictionsButton');
}

function renderContradictionList(containerId, detectButtonId) {
  const container = byId(containerId);
  if (!container) return;
  clear(container);
  const detect = byId(detectButtonId);
  if (detect) detect.classList.toggle('hidden', state.mode === 'demo' || !canManageCurrentProject());
  if (state.mode === 'demo') { setStatus(container, 'DEMO DATA · Contradiction review is available in authenticated projects.'); return; }
  if (!state.selectedProjectId) { setStatus(container, 'Select a project to review contradiction candidates.'); return; }
  if (state.contradictionError) { setStatus(container, `Could not load contradiction candidates: ${state.contradictionError}`, 'error'); return; }
  if (!state.contradictions.length) { setStatus(container, 'No candidates yet. Check approved findings after analyzing sources.'); return; }
  state.contradictions.forEach((candidate) => {
    const confirmed = candidate.status === 'confirmed_conflict';
    const card = node('article', undefined, `contradiction-card rounded-xl border p-4 ${confirmed ? 'border-rose-300/30 bg-rose-500/[0.07]' : 'border-amber-300/15 bg-white/[0.025]'}`);
    const heading = node('div', undefined, 'flex flex-wrap items-center justify-between gap-2');
    heading.append(node('h3', (candidate.claims || []).map((claim) => claim.finding?.title || claim.summary).join(' ↔ ') || 'Contradiction candidate', 'text-sm font-semibold text-white break-words'));
    heading.append(node('span', contradictionStatusLabel(candidate.status), `rounded-full px-2.5 py-1 text-[10px] font-mono ${confirmed ? 'bg-rose-500/20 text-rose-200' : candidate.status === 'dismissed' ? 'bg-white/10 text-white/45' : 'bg-amber-500/15 text-amber-200'}`));
    card.append(heading, node('p', confirmed ? 'Human-confirmed conflict · included only in newly generated handovers.' : 'Unconfirmed suggestion · excluded from handovers until an authorized reviewer confirms it.', 'mt-2 text-xs text-white/50'));
    if (candidate.explanation) card.append(node('p', candidate.explanation, 'mt-2 text-xs leading-relaxed text-white/65'));
    const evidenceList = node('div', undefined, 'mt-3 grid gap-2 md:grid-cols-2');
    (candidate.evidence || []).forEach((item) => {
      const provenance = contradictionEvidenceView(item);
      const evidence = node('div', undefined, 'rounded-lg border border-white/5 bg-black/15 p-3');
      evidence.append(node('p', `${provenance.sourceName}${provenance.locator ? ` · ${provenance.locator}` : ''}`, 'text-xs font-medium text-sky-200 break-words'));
      evidence.append(node('p', `Immutable revision · ${String(provenance.revisionKey).slice(0, 80)}`, 'mt-1 font-mono text-[10px] text-white/45 break-all'));
      evidence.append(node('p', provenance.verified ? 'Verified exact source passage' : 'Evidence reference', `mt-2 text-[10px] font-mono ${provenance.verified ? 'text-emerald-300' : 'text-amber-200'}`));
      evidence.append(node('blockquote', provenance.verifiedText, 'mt-1 border-l-2 border-violet-500/50 pl-2 text-xs text-white/70 whitespace-pre-wrap break-words'));
      evidenceList.append(evidence);
    });
    card.append(evidenceList);
    if (candidate.reviewReason) {
      const actor = candidate.reviewedBy?.name || candidate.reviewedBy?.email || 'Project reviewer';
      card.append(node('p', `Latest review · ${actor}${candidate.reviewedAt ? ` · ${new Date(candidate.reviewedAt).toLocaleString()}` : ''}`, 'mt-3 text-[10px] text-white/45'));
      card.append(node('p', candidate.reviewReason, 'mt-1 text-xs text-white/65 whitespace-pre-wrap'));
    }
    const actions = node('div', undefined, 'mt-3 flex flex-wrap items-center gap-2');
    if (['candidate', 'in_review'].includes(candidate.status) && canReviewContradiction(candidate)) {
      const confirm = reviewButton(state.contradictionBusyId === candidate._id ? 'Saving…' : 'Confirm conflict', 'bg-rose-500/20 text-rose-100 hover:bg-rose-500/30', () => reviewContradiction(candidate._id, 'confirmed_conflict'));
      const dismiss = reviewButton('Dismiss', 'bg-white/10 text-white/75 hover:bg-white/15', () => reviewContradiction(candidate._id, 'dismissed'));
      confirm.disabled = dismiss.disabled = Boolean(state.contradictionBusyId);
      actions.append(confirm, dismiss);
    } else if (['candidate', 'in_review'].includes(candidate.status)) {
      actions.append(node('span', 'Read only · a reviewer assignment covering both claim categories is required.', 'text-xs text-white/40'));
    }
    if (canReadProjectAudit()) {
      const historyButton = reviewButton(state.contradictionHistory[candidate._id]?.open ? 'Hide review history' : 'Review history', 'bg-white/5 text-white/70 hover:bg-white/10', () => toggleContradictionHistory(candidate._id));
      actions.append(historyButton);
    }
    card.append(actions);
    const history = state.contradictionHistory[candidate._id];
    if (history?.open) {
      const historyPanel = node('div', undefined, 'mt-3 space-y-2 rounded-lg bg-black/15 p-3');
      if (history.loading) historyPanel.append(node('p', 'Loading review history…', 'text-xs text-white/45'));
      else if (history.error) historyPanel.append(node('p', `Could not load review history: ${history.error}`, 'text-xs text-rose-200'));
      else if (!history.events?.length) historyPanel.append(node('p', 'No review events recorded.', 'text-xs text-white/45'));
      else history.events.forEach((event) => historyPanel.append(node('p', `${event.action.replace('contradiction.', '')} · ${event.actorId?.name || event.actorId?.email || 'RELAY user'} · ${new Date(event.createdAt).toLocaleString()}${event.reason ? `\n${event.reason}` : ''}`, 'border-l border-violet-400/30 pl-3 text-xs text-white/65 whitespace-pre-wrap')));
      card.append(historyPanel);
    }
    container.append(card);
  });
}

async function reviewContradiction(candidateId, status) {
  if (!canReviewContradiction(state.contradictions.find((candidate) => candidate._id === candidateId))) return;
  const [rationale] = await accessibleFormDialog({
    title: status === 'confirmed_conflict' ? 'Confirm suspected conflict' : 'Dismiss suspected conflict',
    description: 'Your rationale is recorded in the project review history.',
    fields: [{ label: 'Reviewer rationale', required: true, maxLength: 2000, placeholder: 'Explain how the evidence supports your decision.' }],
    submitLabel: status === 'confirmed_conflict' ? 'Confirm conflict' : 'Dismiss candidate',
    danger: status !== 'confirmed_conflict',
  }) || [];
  if (rationale === undefined) return;
  const checkedRationale = validateReviewerRationale(rationale);
  if (!checkedRationale.valid) { toast('Reviewer rationale must contain 1–2,000 characters.', 'error'); return; }
  state.contradictionBusyId = candidateId; renderContradictions();
  try {
    await api(`/projects/${encodeURIComponent(state.selectedProjectId)}/contradictions/${encodeURIComponent(candidateId)}/review`, { method: 'POST', body: JSON.stringify({ status, reason: checkedRationale.value }) });
    const refreshed = await api(`/projects/${encodeURIComponent(state.selectedProjectId)}/contradictions`);
    state.contradictions = refreshed.candidates || [];
    toast(status === 'confirmed_conflict' ? 'Conflict confirmed by human review.' : 'Candidate dismissed.');
  } catch (error) { toast(`Could not save contradiction review: ${error.message}`, 'error'); }
  finally { state.contradictionBusyId = ''; renderContradictions(); }
}

async function detectContradictions() {
  if (!canManageCurrentProject() || state.mode !== 'real') return;
  const buttons = [byId('detectContradictionsButton'), byId('projectDetectContradictionsButton')].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; button.textContent = 'Checking…'; });
  state.contradictionError = '';
  try {
    const result = await api(`/projects/${encodeURIComponent(state.selectedProjectId)}/contradictions/detect`, { method: 'POST', body: '{}' });
    const refreshed = await api(`/projects/${encodeURIComponent(state.selectedProjectId)}/contradictions`);
    state.contradictions = refreshed.candidates || [];
    toast(result.createdCount ? `${result.createdCount} suspected candidate(s) need human review.` : 'No new contradiction candidates were found.');
  } catch (error) { state.contradictionError = error.message; toast(`Could not check for contradictions: ${error.message}`, 'error'); }
  finally { buttons.forEach((button) => { button.disabled = false; button.textContent = 'Check approved findings'; }); renderContradictions(); }
}

async function toggleContradictionHistory(candidateId) {
  const existing = state.contradictionHistory[candidateId];
  if (existing?.open) { state.contradictionHistory[candidateId] = { ...existing, open: false }; renderContradictions(); return; }
  state.contradictionHistory[candidateId] = { open: true, loading: true, events: [] }; renderContradictions();
  try {
    const data = await api(`/projects/${encodeURIComponent(state.selectedProjectId)}/contradictions/${encodeURIComponent(candidateId)}/history`);
    state.contradictionHistory[candidateId] = { open: true, loading: false, events: data.events || [] };
  } catch (error) { state.contradictionHistory[candidateId] = { open: true, loading: false, error: error.message, events: [] }; }
  renderContradictions();
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

function currentProject() {
  return state.projects.find((item) => item._id === state.selectedProjectId) || null;
}

function canReviewFindingInCurrentProject(finding) {
  if (state.mode !== 'real' || !finding || !state.user?.id) return false;
  const project = currentProject();
  if (!project) return false;
  if (project.workflowPolicy?.reviewMode !== 'assigned') return canManageCurrentProject();
  const userId = String(state.user.id);
  return state.assignments.some((assignment) => {
    if (assignment.role !== 'reviewer' || assignment.status !== 'active') return false;
    if (String(assignment.user?._id || assignment.user) !== userId) return false;
    return assignment.scopeType === 'project'
      || (assignment.scopeType === 'category' && assignment.scopeValue === finding.category);
  });
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
  renderAnalysisSelectionCount();
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

async function confirmApproveFinding(findingId) {
  if (await confirmInApp('Approve this finding? This decision will be recorded in the review history.', 'Approve finding')) submitReviewAction(findingId, 'approve');
}

let commentFindingId = '';
let commentAction = '';
async function requestFindingComment(findingId, action) {
  if (state.mode !== 'real') return;
  if (action === 'reject' && !await confirmInApp('Reject this finding? A reason is required and will be recorded in the review history.', 'Reject finding', true)) return;
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
  if (!finding || !canReviewFindingInCurrentProject(finding)) return;
  byId('reviewEditTitleInput').value = finding.title || '';
  const categorySelect = byId('reviewEditCategory');
  [...categorySelect.options].forEach((option) => {
    option.disabled = option.value !== finding.category && !canReviewFindingInCurrentProject({ ...finding, category: option.value });
  });
  categorySelect.value = finding.category || 'Decision';
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
  const selectedSourceIds = [...state.analysisSelection].filter((sourceId) => state.sources.some((source) => String(source._id) === sourceId && source.status === 'processed'));
  const projectId = state.selectedProjectId;
  state.analysisStarting = true; state.analysisJobError = '';
  navigate('findings'); renderAnalysisJob();
  try {
    const data = await api(`/projects/${encodeURIComponent(projectId)}/analyze`, {
      method: 'POST', body: JSON.stringify(selectedSourceIds.length ? { sourceIds: selectedSourceIds } : {}),
    });
    if (state.selectedProjectId !== projectId) return;
    if (selectedSourceIds.length) state.analysisSelection = new Set();
    state.analysisJob = data.job || null;
    renderAnalysisJob();
    if (state.analysisJob) await runAnalysisJob(state.analysisJob._id);
    else { toast(data.message || 'All selected processed sources have already been analyzed.'); await loadProjectData(); }
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
  const evidenceCount = state.findings.reduce((total, finding) => total + (finding.evidence || []).length, 0);
  const confidence = state.findings.length ? Math.round(state.findings.reduce((total, finding) => total + (Number(finding.confidence) || 0), 0) / state.findings.length * 100) : null;
  const put = (id, text) => { const el = byId(id); if (el) el.textContent = String(text); };
  const metrics = dashboardMetrics(state.projects, state.findings);
  const { activeProjects, inReviewProjects, completedProjects, recoveryProjects, pendingFindings: pending, approvedFindings: approved } = metrics;
  put('dashboardProjectCount', state.errors.projects ? '—' : activeProjects);
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
  put('dashboardReadiness', state.errors.findings || !state.findings.length ? '—' : `${Math.round(approved / state.findings.length * 100)}%`);
  const readinessRing = byId('dashboardReadinessRing');
  if (readinessRing) readinessRing.setAttribute('stroke-dasharray', `${!state.errors.findings && state.findings.length ? Math.round(approved / state.findings.length * 100) : 0} 100`);
  put('dashboardExtractedCount', state.findings.length);
  put('dashboardEvidenceCount', evidenceCount);
  put('dashboardConfidence', confidence === null ? '—' : `${confidence}%`);
  put('dashboardAccount', state.user?.email || state.user?.name || 'Signed in');
  put('dashboardCurrentProject', activeProject ? `${activeProject.name} · ${activeProject.deletionState || activeProject.status || 'active'}` : 'Select a project to view its summary.');
  put('workspaceAccount', state.user?.email || state.user?.name || 'Signed in');
  put('workspaceSelectedProject', activeProject ? `${activeProject.name} · ${activeProject.deletionState || activeProject.status || 'active'}` : 'Choose a project');
  const avatar = (state.user?.name || state.user?.email || 'U').split(/[\s@]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || 'U';
  put('topbarAvatar', avatar);
  put('dashboardSummary', state.errors.projects ? `Could not load workspace: ${state.errors.projects}` : activeProject ? `${activeProject.name}: ${state.errors.sources ? 'sources unavailable' : `${state.sources.length} source(s)`}, ${state.errors.findings ? 'findings unavailable' : `${state.findings.length} finding(s)`}.` : activeProjects ? 'Select a project to review its sources and findings.' : recoveryProjects ? `${recoveryProjects} project(s) are in the deletion recovery lifecycle.` : 'Create a project to begin your first handover.');
  const badges = byId('dashboardProjectCount')?.closest('.glass')?.querySelector('.mt-3.flex');
  if (badges) {
    clear(badges);
    badges.append(node('span', `${inReviewProjects} in review`, 'px-2 py-1 rounded-full bg-amber-500/15 text-amber-200 text-[11px]'));
    badges.append(node('span', `${completedProjects} completed`, 'px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-400 text-[11px]'));
    if (recoveryProjects) badges.append(node('span', `${recoveryProjects} in recovery`, 'px-2 py-1 rounded-full bg-rose-500/15 text-rose-200 text-[11px]'));
  }
  const sourceBar = document.querySelector('#view-dashboard .dashboard-source-progress');
  const processedSources = state.sources.filter((source) => source.status === 'processed').length;
  if (sourceBar) sourceBar.style.width = state.errors.sources || !state.sources.length ? '0%' : `${Math.round(processedSources / state.sources.length * 100)}%`;
  const progress = byId('dashboardProgress');
  if (progress) {
    clear(progress);
    progress.append(node('p', state.errors.sources ? `Sources unavailable: ${state.errors.sources}` : activeProject ? `${state.sources.filter((source) => source.status === 'processed').length} of ${state.sources.length} sources processed` : 'Select a project to see source and finding status.', 'text-sm text-white/60'));
    progress.append(node('p', `${pending} finding(s) need review`, 'text-sm text-white/45'));
  }
  const activity = byId('recentActivity');
  if (activity) {
    clear(activity);
    if (state.dashboardAuditEvents.length) {
      state.dashboardAuditEvents.slice(0, 5).forEach((event) => {
        const row = node('div', undefined, 'flex items-start gap-3 border-b border-white/5 pb-3 last:border-0');
        row.append(node('span', '', 'mt-1.5 h-2 w-2 shrink-0 rounded-full bg-violet-500'));
        row.append(node('div', `${String(event.action || 'Project activity').replaceAll('.', ' ')} · ${new Date(event.createdAt).toLocaleString()}`, 'text-xs leading-5 text-white/65'));
        activity.append(row);
      });
    } else {
      const latest = [...state.sources].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 5);
      if (state.dashboardAuditError) activity.append(node('p', 'Audit activity is not available for this account. Recent sources are shown instead.', 'mb-2 text-xs text-white/40'));
      if (!latest.length) activity.append(node('p', activeProject ? 'No source activity yet.' : 'Select a project to view activity.', 'text-sm text-white/45'));
      latest.forEach((source) => activity.append(node('div', `${statusLabel(source.status)} · ${source.originalName}`, 'border-b border-white/5 pb-2 text-sm text-white/65 last:border-0')));
    }
  }
  const pendingList = byId('pendingList');
  if (pendingList) {
    clear(pendingList);
    const items = state.findings.filter((finding) => finding.status === 'pending').slice(0, 3);
    if (!items.length) pendingList.append(node('p', activeProject ? 'No findings need review.' : 'Select a project to see pending findings.', 'text-sm text-white/45 text-center py-4'));
    items.forEach((finding) => {
      const item = node('button', undefined, 'w-full rounded-xl border border-white/10 bg-white/[0.04] p-3 text-left hover:bg-white/[0.08]');
      item.type = 'button'; item.setAttribute('aria-label', `Review ${finding.title}`);
      item.append(node('span', finding.category || 'Finding', 'block text-[10px] font-semibold uppercase tracking-wider text-violet-300'), node('span', finding.title, 'mt-1 block text-sm font-medium text-white/80'));
      item.addEventListener('click', () => navigate('review'));
      pendingList.append(item);
    });
  }
  const recentHandovers = byId('dashboardRecentHandovers');
  if (recentHandovers) {
    clear(recentHandovers);
    if (!activeProject) recentHandovers.append(node('p', 'Select a project to view saved handover versions.', 'text-sm text-white/45'));
    else if (state.handoverError) recentHandovers.append(node('p', `Handovers unavailable: ${state.handoverError}`, 'text-sm text-rose-200'));
    else if (!state.handovers.length) recentHandovers.append(node('p', 'No handover versions saved yet.', 'text-sm text-white/45'));
    else state.handovers.slice(0, 3).forEach((handover) => {
      const status = handover.effectiveStatus || handover.approvalStatus || 'draft';
      const row = node('button', undefined, 'w-full rounded-xl border border-white/5 bg-white/[0.04] p-3 text-left hover:bg-white/[0.08]');
      row.type = 'button'; row.append(node('span', `Version ${handover.version}`, 'text-sm font-semibold text-white'), node('span', status, 'float-right rounded-full bg-indigo-50 px-2 py-1 text-[10px] font-medium text-indigo-700'), node('span', handover.createdAt ? new Date(handover.createdAt).toLocaleDateString() : 'Saved handover', 'mt-1 block text-xs text-white/45'));
      row.addEventListener('click', () => navigate('handover')); recentHandovers.append(row);
    });
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
  const navCounts = { dashboard: pending, projects: state.errors.projects ? '—' : activeProjects, sources: state.errors.sources ? '—' : state.sources.length, findings: state.errors.findings ? '—' : state.findings.length, review: state.errors.findings ? '—' : pending };
  Object.entries(navCounts).forEach(([view, value]) => {
    const badge = document.querySelector(`[data-nav="${view}"] .nav-count`);
    if (badge) { badge.textContent = value ? String(value) : ''; badge.classList.toggle('hidden', !value); }
  });
}

function navigate(view) {
  if (!['sources', 'projects'].includes(view)) stopGitHubPolling();
  const pageCopy = {
    dashboard: ['Dashboard', 'Your project intelligence at a glance.'],
    projects: ['Projects', 'Workspaces, source context, and handover progress.'],
    sources: ['Sources', 'Connect documents and GitHub evidence to your project.'],
    findings: ['AI findings', 'Evidence-backed suggestions for human review.'],
    review: ['Review & approval', 'Make and trace decisions against source evidence.'],
    handover: ['Handover reports', 'Versioned project knowledge, ready to share.'],
    settings: ['Settings', 'Account, permissions, and project recovery.'],
  }[view] || ['RELAY', 'Project knowledge workspace.'];
  if (byId('topbarTitle')) byId('topbarTitle').textContent = pageCopy[0];
  if (byId('topbarBreadcrumb')) byId('topbarBreadcrumb').textContent = `Workspace / ${pageCopy[0]}`;
  if (byId('topbarDescription')) byId('topbarDescription').textContent = pageCopy[1];
  document.querySelectorAll('[id^="view-"]').forEach((section) => section.classList.add('hidden'));
  byId(`view-${view}`)?.classList.remove('hidden');
  if (view === 'projects') byId('projectDetail')?.classList.toggle('hidden', !state.selectedProjectId);
  document.querySelectorAll('.nav-btn').forEach((button) => {
    const active = button.dataset.nav === view;
    button.classList.toggle('bg-white', active); button.classList.toggle('text-[#060A16]', active);
    button.classList.toggle('text-white/70', !active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  byId('sidebar').classList.add('-translate-x-full');
  byId('sidebarBackdrop')?.classList.add('hidden');
  byId('mobileNavToggle')?.setAttribute('aria-expanded', 'false');
  if (view === 'projects') renderProjects();
  if (view === 'sources') renderSources();
  if (view === 'sources') resumeGitHubPolling();
  if (view === 'findings') renderFindings();
  if (view === 'review') renderReview();
  if (view === 'handover') { renderHandover(); loadHandovers(); }
  if (view === 'settings') { byId('settingsNameInput').value = state.user?.name || 'Campus Connect Demo'; byId('settingsEmailInput').value = state.user?.email || ''; loadProjectDeletion(); }
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
    const revisionQuery = evidence?.sourceRevision ? `?revisionId=${encodeURIComponent(evidence.sourceRevision)}` : '';
    const data = await api(`/sources/${encodeURIComponent(sourceId)}/content${revisionQuery}`);
    if (requestId !== evidenceRequest) return;
    const text = data.source?.extractedText || '';
    byId('sourceViewerName').textContent = `${data.source?.originalName || 'Source'}${data.source?.revisionKey ? ` · revision ${data.source.revisionKey}` : ''}`;
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
async function downloadEvidenceSource(sourceId, evidence) {
  if (!sourceId || state.mode === 'demo') { toast('Original file download is unavailable for demo data.', 'error'); return; }
  const status = byId('sourceViewStatus');
  status.textContent = 'Preparing original file…';
  try {
    const headers = new Headers();
    if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
    const revisionQuery = evidence?.sourceRevision ? `?revisionId=${encodeURIComponent(evidence.sourceRevision)}` : '';
    const endpoint = evidence?.sourceRevision
      ? `/sources/${encodeURIComponent(sourceId)}/content${revisionQuery}`
      : `/sources/${encodeURIComponent(sourceId)}/download`;
    const response = await fetch(`${API_URL}${endpoint}`, { headers });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || `Download failed (${response.status})`);
    }
    let blob = await response.blob();
    if (evidence?.sourceRevision) {
      const data = JSON.parse(await blob.text());
      blob = new Blob([data.source?.extractedText || ''], { type: data.source?.mimeType || 'text/plain' });
    }
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = byId('evSourceMeta').textContent || 'source';
    document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    status.textContent = evidence?.sourceRevision ? 'Evidence source revision downloaded.' : 'Original file downloaded.';
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
  byId('downloadSourceButton').onclick = () => downloadEvidenceSource(evidenceSourceId, evidence);
  byId('evidenceModal').classList.remove('hidden');
}
function closeEvidence() { evidenceRequest += 1; byId('evidenceModal')?.classList.add('hidden'); }
function renderHandover() {
  const preview = byId('reportPreview');
  const history = byId('versionHistory');
  if (!preview || !history) return;
  clear(preview); clear(history);
  renderHandoverSignoff(null);
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
    renderHandoverSignoff(null);
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
  renderHandoverSignoff(handover);
  if (versionSelect) versionSelect.value = handover._id;
  const report = handover.reportContent || {};
  const article = node('article', undefined, 'handover-document rounded-xl bg-white p-5 md:p-8 text-[#0A0F1E]');
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
    button.setAttribute('aria-current', String(item._id === handover._id));
    button.append(node('span', `Version ${item.version}`, 'block font-medium'));
    const approvalLabel = item.effectiveStatus || item.approvalStatus || 'draft';
    button.append(node('span', `${new Date(item.createdAt).toLocaleDateString()} · ${item.reportContent?.approvedFindingCount || 0} approved findings · ${approvalLabel}`, 'block mt-1 text-xs text-white/45'));
    button.addEventListener('click', () => selectHandoverVersion(item._id));
    history.append(button);
  });
}

function canSignHandover(handover) {
  return canSignHandoverForUser({ mode: state.mode, project: currentProject(), userId: state.user?.id, assignments: state.assignments, handover });
}

function renderHandoverSignoff(handover) {
  const panel = byId('handoverSignoffPanel');
  if (!panel) return;
  clear(panel);
  if (state.mode === 'demo') { panel.append(node('p', 'DEMO DATA · Sign-off is available in authenticated projects.', 'text-xs text-violet-200/70')); return; }
  if (!state.selectedProjectId) { panel.append(node('p', 'Select a project to view sign-off.', 'text-xs text-white/45')); return; }
  if (!handover) { panel.append(node('p', 'Select a handover version to view its decision and sign-off history.', 'text-xs text-white/45')); return; }
  const status = handover.effectiveStatus || handover.approvalStatus || 'draft';
  const signoffState = state.handoverSignoffs[handover._id];
  panel.append(node('p', `Version ${handover.version} · ${status}`, `text-sm font-semibold ${status === 'approved' ? 'text-emerald-200' : status === 'rejected' ? 'text-rose-200' : status === 'superseded' ? 'text-white/45' : 'text-amber-200'}`));
  if (state.handoverSignoffError) panel.append(node('p', `Could not load sign-off history: ${state.handoverSignoffError}`, 'text-xs text-rose-200'));
  if (signoffState?.loading) panel.append(node('p', 'Loading decision history…', 'text-xs text-white/45'));
  else if (signoffState?.error) panel.append(node('p', `Could not load decision history: ${signoffState.error}`, 'text-xs text-rose-200'));
  else if (!signoffState?.signoffs?.length) panel.append(node('p', 'No sign-off decision recorded for this version.', 'text-xs text-white/45'));
  else signoffState.signoffs.forEach((entry) => {
    panel.append(node('p', `${entry.decision === 'approved' ? 'Approved' : 'Rejected'} by ${entry.signer?.name || entry.signer?.email || 'Approver'} · ${new Date(entry.createdAt).toLocaleString()}`, 'text-xs text-white/65'));
    if (entry.reason) panel.append(node('p', `Reason: ${entry.reason}`, 'text-xs text-rose-200 whitespace-pre-wrap'));
    if (entry.comment) panel.append(node('p', `Comment: ${entry.comment}`, 'text-xs text-white/45 whitespace-pre-wrap'));
  });
  if (status === 'superseded') panel.append(node('p', 'This version is superseded and cannot receive a new approval.', 'text-xs text-amber-200/80'));
  else if (handover.approvalStatus === 'pending' && String(handover.createdBy?._id || handover.createdBy) === String(state.user?.id)) panel.append(node('p', 'You created this version and cannot approve it.', 'text-xs text-white/45'));
  else if (handover.approvalStatus === 'pending' && canSignHandover(handover)) {
    const controls = node('div', undefined, 'flex flex-wrap gap-2');
    const approve = reviewButton(state.handoverSignoffBusyId === handover._id ? 'Saving…' : 'Approve version', 'bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/30', () => submitHandoverSignoff(handover, 'approved'));
    const reject = reviewButton('Reject version', 'bg-rose-500/20 text-rose-100 hover:bg-rose-500/30', () => submitHandoverSignoff(handover, 'rejected'));
    approve.disabled = reject.disabled = Boolean(state.handoverSignoffBusyId);
    controls.append(approve, reject); panel.append(controls);
  } else if (handover.approvalStatus === 'pending') panel.append(node('p', 'Read only · an active approver assignment for this version is required.', 'text-xs text-white/45'));
}

async function submitHandoverSignoff(handover, decision) {
  if (!canSignHandover(handover)) return;
  const fields = decision === 'rejected'
    ? [{ label: 'Reason for rejection', required: true, maxLength: 2000 }, { label: 'Sign-off comment', required: true, maxLength: 5000 }]
    : [{ label: 'Approval comment', required: true, maxLength: 5000 }];
  const values = await accessibleFormDialog({ title: decision === 'approved' ? `Approve handover Version ${handover.version}` : `Reject handover Version ${handover.version}`, description: 'This decision is permanently recorded against this exact handover version.', fields, submitLabel: decision === 'approved' ? 'Approve version' : 'Reject version', danger: decision === 'rejected' });
  if (!values) return;
  const reason = decision === 'rejected' ? values[0] : undefined;
  const comment = decision === 'rejected' ? values[1] : values[0];
  const validated = validateSignoffInput({ decision, comment, reason });
  if (!validated.valid) { toast(decision === 'rejected' ? 'A sign-off comment and rejection reason are required.' : 'An approval comment is required.', 'error'); return; }
  state.handoverSignoffBusyId = handover._id; renderHandoverSignoff(handover);
  try {
    await api(`/handovers/${encodeURIComponent(handover._id)}/signoffs`, { method: 'POST', body: JSON.stringify({ decision, comment: validated.comment, ...(validated.reason ? { reason: validated.reason } : {}) }) });
    toast(decision === 'approved' ? `Handover Version ${handover.version} approved.` : `Handover Version ${handover.version} rejected.`);
    await loadHandovers();
  } catch (error) { state.handoverSignoffError = error.message; toast(`Could not save handover sign-off: ${error.message}`, 'error'); }
  finally { state.handoverSignoffBusyId = ''; renderHandover(); }
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
    state.handoverSignoffs = {};
    const signoffResults = await Promise.allSettled(state.handovers.map((handover) => api(`/handovers/${encodeURIComponent(handover._id)}/signoffs`)));
    if (requestId !== handoverRequest || projectId !== state.selectedProjectId) return;
    for (const [index, response] of signoffResults.entries()) {
      const handoverId = state.handovers[index]._id;
      state.handoverSignoffs[handoverId] = response.status === 'fulfilled'
        ? { signoffs: response.value.signoffs || [] }
        : { error: response.reason.message, signoffs: [] };
    }
    if (!state.handovers.some((item) => item._id === state.selectedHandoverId)) state.selectedHandoverId = state.handovers[0]?._id || '';
  } catch (error) {
    if (requestId !== handoverRequest || projectId !== state.selectedProjectId) return;
    state.handovers = []; state.selectedHandoverId = ''; state.handoverError = error.message;
  } finally {
    if (requestId === handoverRequest) { state.handoverLoading = false; renderHandover(); }
  }
}
function selectHandoverVersion(handoverId) { state.selectedHandoverId = handoverId; renderHandover(); }

async function loadProjectDeletion() {
  const panel = byId('projectDeletionPanel');
  if (!panel) return;
  clear(panel);
  const project = currentProject();
  if (state.mode === 'demo') { setStatus(panel, 'DEMO DATA · Project deletion is disabled in the sample workspace.'); return; }
  if (!project) { setStatus(panel, 'Select a project to view its deletion settings.'); return; }
  if (!isCurrentProjectOwner(project, state.user?.id)) { setStatus(panel, 'Only the project owner can view deletion and recovery status.'); return; }
  state.projectDeletionLoading = true;
  setStatus(panel, 'Loading project retention status…', 'loading');
  try {
    const result = await api(`/projects/${encodeURIComponent(project._id)}/deletion`);
    if (project._id !== state.selectedProjectId) return;
    state.projectDeletion = result.deletion;
    state.projectDeletionError = '';
  } catch (error) { state.projectDeletionError = error.message; state.projectDeletion = null; }
  finally { state.projectDeletionLoading = false; renderProjectDeletion(); }
}

function renderProjectDeletion() {
  const panel = byId('projectDeletionPanel');
  if (!panel) return;
  clear(panel);
  const project = currentProject();
  if (!project || !isCurrentProjectOwner(project, state.user?.id) || state.mode !== 'real') { setStatus(panel, 'Project deletion controls are available to the owner of a saved project.'); return; }
  if (state.projectDeletionLoading) { setStatus(panel, 'Loading project retention status…', 'loading'); return; }
  if (state.projectDeletionError) { setStatus(panel, `Could not load deletion status: ${state.projectDeletionError}`, 'error'); }
  const deletion = state.projectDeletion;
  const projectState = deletion?.deletionState || project.deletionState || 'active';
  if (projectState === 'active') {
    panel.append(node('p', 'This project is active. Deleting it freezes access now and permanently removes project content after the 30-day recovery window.', 'text-sm text-white/60'));
    const button = node('button', state.projectDeletionBusy ? 'Requesting…' : 'Delete this project', 'mt-3 rounded-full border border-rose-300/20 bg-rose-500/15 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-500/25 disabled:opacity-50');
    button.type = 'button'; button.disabled = state.projectDeletionBusy;
    button.addEventListener('click', requestProjectDeletionUI); panel.append(button); return;
  }
  const status = projectState === 'queued' ? 'Recovery window' : projectState === 'purging' ? 'Cleanup in progress' : projectState === 'blocked' ? 'Cleanup needs attention' : 'Deletion complete';
  panel.append(node('p', `${status} · ${projectState}`, 'text-sm font-semibold text-amber-200'));
  if (deletion?.deletionRequestedAt) panel.append(node('p', `Requested ${new Date(deletion.deletionRequestedAt).toLocaleString()}`, 'mt-1 text-xs text-white/50'));
  if (deletion?.recoveryEndsAt) panel.append(node('p', `Recovery deadline ${new Date(deletion.recoveryEndsAt).toLocaleString()}`, 'mt-1 text-xs text-white/50'));
  const job = deletion?.job;
  if (job) {
    const stage = String(job.phase || 'cleanup').replaceAll('_', ' ');
    panel.append(node('p', `Cleanup ${job.status || 'queued'} · ${stage}${Number.isFinite(job.attemptCount) ? ` · attempt ${job.attemptCount}` : ''}`, 'mt-2 text-xs text-white/60'));
    if (job.status === 'retry_wait' && job.nextAttemptAt) panel.append(node('p', `Next retry after ${new Date(job.nextAttemptAt).toLocaleString()}.`, 'mt-1 text-xs text-amber-100/70'));
    if (job.lastErrorCode) panel.append(node('p', safeDeletionError(job.lastErrorCode), 'mt-1 text-xs text-rose-200/80'));
  }
  const recoverable = isDeletionRecoverable({ ...deletion, deletionState: projectState, job });
  if (recoverable) {
    const button = node('button', state.projectDeletionBusy ? 'Recovering…' : 'Recover project', 'mt-3 rounded-full bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-50');
    button.type = 'button'; button.disabled = state.projectDeletionBusy; button.addEventListener('click', recoverProjectDeletionUI); panel.append(button);
  } else if (projectState !== 'complete') panel.append(node('p', 'Recovery is unavailable after cleanup begins. Contact the project owner if this status looks unexpected.', 'mt-3 text-xs text-white/40'));
}

function safeDeletionError(code) {
  return deletionErrorMessage(code);
}

async function requestProjectDeletionUI() {
  const project = currentProject();
  if (!isCurrentProjectOwner(project, state.user?.id) || state.projectDeletionBusy) return;
  if (!await confirmInApp(`Request deletion of “${project.name}”? Access will stop immediately. Recovery is available for 30 days before cleanup.`, 'Delete project', true)) return;
  state.projectDeletionBusy = true; renderProjectDeletion();
  try {
    const result = await api(`/projects/${encodeURIComponent(project._id)}`, { method: 'DELETE' });
    project.deletionState = result.deletion?.state || 'queued';
    project.deletionRequestedAt = result.deletion?.requestedAt || new Date().toISOString();
    state.projectDeletion = { ...(state.projectDeletion || {}), ...result.deletion, deletionState: project.deletionState, deletionRequestedAt: result.deletion?.requestedAt, job: { status: 'queued', phase: 'source_files', attemptCount: 0 } };
    state.projectDeletionError = '';
    renderProjects();
    toast('Project deletion requested. The recovery window has started.');
  } catch (error) { state.projectDeletionError = error.message; toast(`Could not request project deletion: ${error.message}`, 'error'); }
  finally { state.projectDeletionBusy = false; renderProjectDeletion(); }
}

async function recoverProjectDeletionUI() {
  const project = currentProject();
  if (!isCurrentProjectOwner(project, state.user?.id) || state.projectDeletionBusy) return;
  if (!await confirmInApp(`Recover “${project.name}” and restore project access?`, 'Recover project')) return;
  state.projectDeletionBusy = true; renderProjectDeletion();
  try {
    await api(`/projects/${encodeURIComponent(project._id)}/deletion/cancel`, { method: 'POST', body: '{}' });
    project.deletionState = 'active';
    project.deletionRequestedAt = undefined;
    state.projectDeletion = { deletionState: 'active' };
    state.projectDeletionError = '';
    renderProjects();
    toast('Project recovered. Access has been restored.');
  } catch (error) { state.projectDeletionError = error.message; toast(`Could not recover project: ${error.message}`, 'error'); }
  finally { state.projectDeletionBusy = false; renderProjectDeletion(); }
}

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
    button.setAttribute('aria-selected', String(active));
  });
  const content = byId('projectTabContent');
  clear(content);
  const project = state.projects.find((item) => item._id === state.selectedProjectId);
  if (tab === 'overview') {
    if (!project) { setStatus(content, 'Select a project to view its overview.'); return; }
    const overview = node('div', undefined, 'space-y-5');
    const summary = node('div', undefined, 'rounded-2xl border border-white/10 bg-white/[0.04] p-5');
    summary.append(node('p', project.description || 'No project description has been added.', 'text-sm leading-6 text-white/65'));
    const stats = node('div', undefined, 'grid grid-cols-2 gap-3 lg:grid-cols-4');
    [
      ['Sources', state.errors.sources ? 'Unavailable' : state.sources.length],
      ['Processed', state.errors.sources ? 'Unavailable' : state.sources.filter((source) => source.status === 'processed').length],
      ['Findings', state.errors.findings ? 'Unavailable' : state.findings.length],
      ['Pending review', state.errors.findings ? 'Unavailable' : state.findings.filter((finding) => finding.status === 'pending').length],
    ].forEach(([label, value]) => {
      const tile = node('div', undefined, 'rounded-xl border border-white/10 bg-white/[0.04] p-4');
      tile.append(node('p', label, 'text-xs text-white/45'), node('p', String(value), 'mt-2 text-2xl font-semibold text-white'));
      stats.append(tile);
    });
    const actions = node('div', undefined, 'flex flex-wrap gap-2');
    [['Sources', 'sources'], ['Findings', 'findings'], ['Review queue', 'review'], ['Handovers', 'handover']].forEach(([label, destination]) => {
      const action = reviewButton(label, 'bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/15', () => navigate(destination));
      actions.append(action);
    });
    overview.append(summary, stats, actions); content.append(overview);
  } else if (tab === 'team') renderTeam();
  else if (tab === 'sources' || tab === 'findings') navigate(tab);
  else if (tab === 'contradictions') {
    const section = node('section', undefined, 'space-y-4');
    const header = node('div', undefined, 'flex flex-wrap items-center justify-between gap-3');
    header.append(node('div', undefined, ''));
    header.firstChild.append(node('h4', 'Cross-source contradictions', 'text-base font-semibold text-white'), node('p', 'Candidates remain suspected until an authorized human confirms them.', 'mt-1 text-xs text-white/45'));
    const detect = reviewButton('Check approved findings', 'rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500', detectContradictions);
    detect.id = 'projectDetectContradictionsButton'; header.append(detect);
    const list = node('div', undefined, 'space-y-3'); list.id = 'projectContradictionList'; list.setAttribute('aria-live', 'polite');
    section.append(header, list); content.append(section); renderContradictions();
  }
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
    const [data, assignmentData] = await Promise.all([
      api(`/projects/${projectId}/members`),
      api(`/projects/${projectId}/assignments`),
    ]);
    if (state.selectedProjectId !== decodeURIComponent(projectId)) return;
    state.assignments = assignmentData.assignments || [];
    state.assignmentError = '';
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
    renderAssignmentPanel(section, projectId, members, assignmentData);
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

function renderAssignmentPanel(section, projectId, members, assignmentData) {
  const panel = node('section', undefined, 'rounded-2xl border border-violet-300/10 bg-[#0B122A] p-4 space-y-4');
  const title = node('div', undefined, '');
  title.append(
    node('h4', 'Reviewer and approver assignments', 'text-white font-semibold'),
    node('p', 'Assignments add a specific workflow permission. They never grant project editing or source upload.', 'mt-1 text-xs text-white/45'),
  );
  panel.append(title);
  const assignments = assignmentData.assignments || [];
  const activeReviewers = assignments.filter((item) => item.role === 'reviewer' && item.status === 'active');
  if (!activeReviewers.length && currentProject()?.workflowPolicy?.reviewMode === 'assigned') {
    panel.append(node('p', 'No active reviewers are assigned. Findings remain read-only until the owner assigns reviewers.', 'rounded-xl bg-amber-400/10 p-3 text-xs text-amber-100'));
  }
  if (!assignments.length) panel.append(node('p', 'No workflow assignments yet.', 'text-xs text-white/45'));
  const list = node('div', undefined, 'space-y-2');
  assignments.forEach((assignment) => {
    const row = node('div', undefined, 'flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3');
    const identity = assignment.user?.name || assignment.user?.email || 'Project member';
    const scope = assignment.scopeType === 'category' ? `Category · ${assignment.scopeValue}`
      : assignment.scopeType === 'handover' ? 'Handover-specific' : 'Entire project';
    const status = assignment.status === 'active' ? 'ACTIVE' : 'REVOKED';
    row.append(node('div', `${identity} · ${assignment.role.replace('_', ' ')} · ${scope}`, 'flex-1 text-xs text-white/75'));
    row.append(node('span', status, `text-[10px] font-mono ${assignment.status === 'active' ? 'text-emerald-200' : 'text-white/40'}`));
    if (assignmentData.canManageAssignments && assignment.status === 'active') {
      const revoke = node('button', 'Revoke', 'rounded-full bg-rose-500/15 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-500/25');
      revoke.type = 'button';
      revoke.addEventListener('click', async () => {
        if (!await confirmInApp(`Revoke ${assignment.role.replace('_', ' ')} access for ${identity}? This will be recorded in the assignment history.`, 'Revoke assignment', true)) return;
        try {
          await api(`/projects/${projectId}/assignments/${assignment._id}/revoke`, { method: 'POST', body: JSON.stringify({ reason: 'Revoked by project owner.' }) });
          await loadProjectData();
          await renderTeam();
        } catch (error) { toast(`Could not revoke assignment: ${error.message}`, 'error'); }
      });
      row.append(revoke);
    }
    list.append(row);
  });
  panel.append(list);

  if (assignmentData.canManageAssignments) {
    const form = document.createElement('form');
    form.className = 'rounded-xl border border-white/10 bg-black/10 p-3 space-y-3';
    form.append(node('h5', 'Assign a workflow role', 'text-sm font-semibold text-white'));
    const controls = node('div', undefined, 'grid gap-2 sm:grid-cols-2');
    const user = document.createElement('select');
    user.className = 'bg-[#111B34] border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white';
    user.setAttribute('aria-label', 'Member to assign');
    members.forEach((member) => user.add(new Option(`${member.user?.name || member.user?.email || 'Member'} · ${member.role}`, member.memberId)));
    const role = document.createElement('select');
    role.className = user.className;
    role.setAttribute('aria-label', 'Workflow assignment role');
    [['reviewer', 'Reviewer'], ['approver', 'Approver'], ['audit_reader', 'Audit reader']].forEach(([value, label]) => role.add(new Option(label, value)));
    const scope = document.createElement('select');
    scope.className = user.className;
    scope.setAttribute('aria-label', 'Assignment scope');
    scope.add(new Option('Entire project', 'project'));
    scope.add(new Option('One finding category', 'category'));
    const category = document.createElement('select');
    category.className = user.className;
    category.setAttribute('aria-label', 'Finding category scope');
    categories.slice(1).forEach((value) => category.add(new Option(value, value)));
    category.classList.add('hidden');
    scope.addEventListener('change', () => category.classList.toggle('hidden', scope.value !== 'category'));
    controls.append(user, role, scope, category);
    const submit = node('button', 'Create assignment', 'rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50');
    submit.type = 'submit';
    submit.disabled = !members.length;
    const message = node('p', '', 'hidden text-xs');
    form.append(controls, submit, message);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true; submit.textContent = 'Saving…'; message.className = 'hidden text-xs';
      const body = { userId: user.value, role: role.value, scopeType: scope.value };
      if (scope.value === 'category') body.scopeValue = category.value;
      try {
        await api(`/projects/${projectId}/assignments`, { method: 'POST', body: JSON.stringify(body) });
        toast('Workflow assignment created');
        await loadProjectData();
        await renderTeam();
      } catch (error) { message.textContent = error.message; message.className = 'text-xs text-rose-300'; }
      finally { submit.disabled = !members.length; submit.textContent = 'Create assignment'; }
    });
    panel.append(form);

    const project = currentProject();
    const policy = document.createElement('form');
    policy.className = 'rounded-xl border border-white/10 p-3 space-y-3';
    policy.append(node('h5', 'Workflow policy', 'text-sm font-semibold text-white'));
    const policyControls = node('div', undefined, 'grid gap-2 sm:grid-cols-2');
    const reviewMode = document.createElement('select'); reviewMode.className = user.className; reviewMode.setAttribute('aria-label', 'Finding review workflow');
    reviewMode.add(new Option('Legacy: owners and editors', 'legacy_editors'));
    reviewMode.add(new Option('Assigned reviewers', 'assigned'));
    reviewMode.value = project?.workflowPolicy?.reviewMode || 'legacy_editors';
    const signoffMode = document.createElement('select'); signoffMode.className = user.className; signoffMode.setAttribute('aria-label', 'Handover sign-off workflow');
    signoffMode.add(new Option('Sign-off not enabled', 'none'));
    signoffMode.add(new Option('Assigned approvers', 'assigned'));
    signoffMode.value = project?.workflowPolicy?.signoffMode || 'none';
    policyControls.append(reviewMode, signoffMode);
    const savePolicy = node('button', 'Save workflow policy', 'rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/15');
    savePolicy.type = 'submit';
    const policyMessage = node('p', 'Existing projects keep legacy review behavior until the owner opts in. Assigned mode requires an active reviewer.', 'text-xs text-white/45');
    policy.append(policyControls, savePolicy, policyMessage);
    policy.addEventListener('submit', async (event) => {
      event.preventDefault();
      savePolicy.disabled = true; savePolicy.textContent = 'Saving…';
      try {
        const result = await api(`/projects/${projectId}/workflow-policy`, {
          method: 'PATCH', body: JSON.stringify({ reviewMode: reviewMode.value, signoffMode: signoffMode.value }),
        });
        if (project) project.workflowPolicy = result.workflowPolicy;
        toast('Workflow policy updated');
        await loadProjectData();
        await renderTeam();
      } catch (error) { policyMessage.textContent = error.message; policyMessage.className = 'text-xs text-rose-300'; }
      finally { savePolicy.disabled = false; savePolicy.textContent = 'Save workflow policy'; }
    });
    panel.append(policy);
  } else if (!assignmentData.canManageAssignments) {
    panel.append(node('p', 'Only the project owner can create, reassign, revoke, or change workflow assignments.', 'text-xs text-white/40'));
  }
  section.append(panel);
}

async function changeMemberRole(memberId, role) {
  if (!isProjectOwner() || !await confirmInApp(`Change this project member's role to ${role}?`, 'Update project role')) return;
  try {
    await api(`/projects/${encodeURIComponent(state.selectedProjectId)}/members/${encodeURIComponent(memberId)}`, { method: 'PATCH', body: JSON.stringify({ role }) });
    toast('Member role updated'); await renderTeam();
  } catch (error) { toast(`Could not update member role: ${error.message}`, 'error'); }
}

async function removeProjectMember(memberId, label) {
  if (!isProjectOwner() || !await confirmInApp(`Remove ${label} from this project? Their project access and active assignments will be revoked.`, 'Remove project member', true)) return;
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

async function restoreSession(token) {
  if (!token) return null;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
  try {
    const data = await api('/auth/me', { signal: controller.signal });
    if (state.mode !== 'real' || state.token !== token) return null;
    state.user = data.user;
    return data.user;
  } catch (error) {
    if (state.mode === 'real' && state.token === token) expireSession();
    if (timedOut) throw new Error('Saved session verification timed out.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function initializeStartup() {
  const splash = byId('welcomeSplash');
  const startedAt = performance.now();
  const status = byId('startupStatus');
  const slowStatusTimer = window.setTimeout(() => {
    if (status) status.textContent = state.token ? 'Verifying your saved session with RELAY…' : 'Preparing secure sign-in…';
  }, 1400);
  const route = await resolveInitialRoute({ token: state.token, restoreSession });
  window.clearTimeout(slowStatusTimer);
  if (route.screen === 'app') {
    state.user = route.user;
    showApp();
  } else {
    byId('app').classList.add('hidden');
    byId('authOverlay').classList.remove('hidden');
    if (route.error) {
      byId('authError').textContent = 'Your saved session could not be restored. Sign in again to continue.';
      byId('authError').classList.remove('hidden');
    }
  }
  const remaining = remainingSplashTime(startedAt);
  if (remaining) await new Promise((resolve) => window.setTimeout(resolve, remaining));
  splash?.classList.add('is-leaving');
  window.setTimeout(() => {
    if (splash) { splash.hidden = true; splash.setAttribute('aria-busy', 'false'); }
    if (route.screen === 'login') byId('authEmail')?.focus({ preventScroll: true });
  }, 520);
}

Object.assign(window, { login, toggleAuthMode, logout, togglePass, toggleSidebar, toggleDesktopSidebar, navigate, openCreateProject, selectProject, handleUpload, simulateAnalyze, setReviewFilter, openEvidence, closeEvidence, closeReviewDialogs, generateReport, downloadPDF, downloadZip, openProject, switchProjectTab, renderProjects, renderFindings, renderSources, enterDemo, exitDemo, searchFindings, renderHandover, selectHandoverVersion, detectContradictions });
bindEvents();
bindAuthMotion();
try {
  if (window.lucide) window.lucide.createIcons();
} catch (error) {
  console.error('Lucide icon initialization failed', error);
}
initializeStartup();
