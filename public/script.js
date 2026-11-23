/**
 * Kusina Moderna Frontend Application Logic (Vanilla ES6+ JavaScript)
 */

(() => {
  'use strict';

  /* 
   * 1. APPLICATION STATE
   *  */

  const RECENT_ORDERS_KEY = 'km_recent_orders';
  const PAGE_VIEW_FLAG = 'km_session_pageview_logged';
  const FALLBACK_IMG = './images/default-food.svg';

  const state = {
    authToken: null,            // Signed Bearer token held strictly in JS memory
    user: null,                 // { id, username, role }
    activeView: 'public',       // 'public' | 'portal'
    activePortalTab: 'orders',  // 'analytics' | 'pos' | 'orders' | 'stock' | 'menu' | 'accounts'

    menu: [],
    orders: [],
    users: [],
    analyticsData: null,        // { settings, menu, orders, tracking, users }
    analyticsRange: 'all',      // 'all' | '7d' | 'today'

    // Public ordering state
    publicCategory: 'All',
    publicSearch: '',
    publicOrderType: 'Dine-In',
    publicCart: [],             // [{ id, name, price, qty }]
    menuStartTime: Date.now(),
    lastPlacedOrderId: null,
    activeDetailDishId: null,

    // Walk-In POS state
    posCategory: 'All',
    posSearch: '',
    posOrderType: 'Dine-In',
    posCart: [],

    // Order Queue filters
    orderSearch: '',
    orderStatusFilter: 'All',
    orderSourceFilter: 'All',

    // Chart.js instances & responsive observer
    charts: {
      revenueChart: null,
      engagementChart: null,
      categoryChart: null,
      hourlyChart: null
    },
    analyticsResizeObserver: null,
    lastChartNarrowMode: null,

    // Snapshot used for Excel CSV exports
    computedAnalytics: null,

    // Pending confirmation modal handler
    pendingConfirmAction: null,

    // Draft dish photo upload state (uploaded ONLY on Save Dish to prevent orphan files cuh)
    dishPhotoDraft: {
      dataUrl: null,
      filename: '',
      removed: false,
      currentPath: FALLBACK_IMG
    }
  };

  /* 
   * FORMATTING, ESCAPING & LOCAL TIMEZONE HELPERS
   *  */

  function escapeHTML(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeImageSrc(src) {
    const raw = String(src || '').trim();
    if (/^\.\/images\/[a-z0-9._-]+$/i.test(raw)) return raw;
    return FALLBACK_IMG;
  }

  function formatPeso(amount) {
    const num = Number(amount);
    const safe = Number.isFinite(num) ? num : 0;
    return `₱${safe.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return '—';
    const sec = Math.max(0, Math.round(Number(seconds)));
    if (sec < 60) return `${sec}s`;
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  }

  // Build local calendar date key YYYY-MM-DD (prevents UTC shift for PHT morning orders)
  function getLocalDateKey(input) {
    const d = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function formatShortDate(dateKey) {
    if (!dateKey) return '—';
    const [y, m, d] = dateKey.split('-').map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1);
    return dt.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatCompactChartDate(dateKey) {
    if (!dateKey) return '—';
    const [y, m, d] = dateKey.split('-').map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1);
    return dt.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
  }

  function truncateChartLabel(text, maxLen) {
    const str = String(text || '');
    if (str.length <= maxLen) return str;
    return `${str.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
  }

  function formatDisplayDateTime(isoStr) {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-PH', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function formatHourLabel(hour24) {
    const h = ((Number(hour24) % 24) + 24) % 24;
    const suffix = h >= 12 ? 'PM' : 'AM';
    const display = h % 12 === 0 ? 12 : h % 12;
    return `${display}:00 ${suffix}`;
  }

  function formatHourRange(hour24) {
    return `${formatHourLabel(hour24)} – ${formatHourLabel((Number(hour24) + 1) % 24)}`;
  }

  function getStatusPillClass(status) {
    if (status === 'Completed' || status === 'Ready') return 'pill-success';
    if (status === 'Pending' || status === 'Preparing') return 'pill-warning';
    if (status === 'Cancelled') return 'pill-danger';
    return 'pill-neutral';
  }

  function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'toast-error' : 'toast-success'}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3200);
  }

  function showBackendBanner(message) {
    const banner = document.getElementById('backendBanner');
    const msg = document.getElementById('backendBannerMsg');
    if (!banner || !msg) return;
    if (message) msg.textContent = message;
    banner.classList.remove('hidden');
  }

  /* 
   * 3. SAFE API CLIENT (With Static/Offline Backend Guard sa Stackoverflow kinuha - Bred)
   *  */

  async function apiFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    if (state.authToken) {
      headers['Authorization'] = `Bearer ${state.authToken}`;
    }

    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers,
        body: options.body !== undefined && typeof options.body !== 'string'
          ? JSON.stringify(options.body)
          : options.body
      });
    } catch {
      showBackendBanner('Cannot reach the Kusina Moderna backend server. Run "npm start" locally or deploy via Render.com.');
      throw new Error('Backend server is unreachable.');
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      showBackendBanner('Backend API returned non-JSON content. Make sure the Node.js Express server is running (npm start).');
      throw new Error('Backend server is not running.');
    }

    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && state.authToken) {
        handleSessionExpired();
      }
      throw new Error(data?.error || `Request failed (${response.status})`);
    }
    return data;
  }

  function handleSessionExpired() {
    state.authToken = null;
    state.user = null;
    switchToPublicView();
    showToast('Session expired. Please sign in again.', 'error');
  }

  /* 
   * SILENT CUSTOMER BEHAVIOR TELEMETRY (Fire-and-Forget)
   *  */

  function trackEvent(payload) {
    // Never log Staff/Admin portal sessions as customer engagement
    if (state.user || state.activeView !== 'public') return;
    fetch('./api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {});
  }

  function logInitialPageView() {
    if (state.user) return;
    try {
      if (sessionStorage.getItem(PAGE_VIEW_FLAG)) return;
      sessionStorage.setItem(PAGE_VIEW_FLAG, '1');
    } catch {
      // Proceed silently if storage is blocked
    }
    trackEvent({ type: 'page_view' });
  }

  /* 
   * 5. MODAL, DRAWER & SCROLL-LOCK MANAGEMENT
   *  */

  function syncScrollLock() {
    const anyModalOpen = Boolean(document.querySelector('.modal-backdrop:not(.hidden)'));
    const drawerOpen = Boolean(document.getElementById('publicCartPanel')?.classList.contains('drawer-open'));
    document.body.classList.toggle('scroll-locked', anyModalOpen || drawerOpen);
  }

  function openModal(modalId) {
    const el = document.getElementById(modalId);
    if (!el) return;
    el.classList.remove('hidden');
    syncScrollLock();
  }

  function closeAllModals() {
    document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
    state.pendingConfirmAction = null;
    resetDishPhotoDraft(FALLBACK_IMG);
    syncScrollLock();
  }

  function openCartDrawer() {
    if (window.innerWidth >= 1024) {
      document.getElementById('publicCartPanel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    document.getElementById('publicCartPanel')?.classList.add('drawer-open');
    document.getElementById('cartDrawerBackdrop')?.classList.remove('hidden');
    syncScrollLock();
  }

  function closeCartDrawer() {
    document.getElementById('publicCartPanel')?.classList.remove('drawer-open');
    document.getElementById('cartDrawerBackdrop')?.classList.add('hidden');
    syncScrollLock();
  }

  function openConfirmModal(title, message, onConfirm) {
    document.getElementById('confirmActionTitle').textContent = title;
    document.getElementById('confirmActionMessage').textContent = message;
    state.pendingConfirmAction = onConfirm;
    openModal('confirmActionModal');
  }

  /* 
   * 6. PUBLIC WEBSITE: MENU, DISH PREVIEW, CART & ORDER TRACKING
   *  */

  async function loadMenu() {
    const items = await apiFetch('./api/menu');
    state.menu = Array.isArray(items) ? items : [];
    renderPublicMenu();
    if (state.activeView === 'portal') {
      renderPosMenu();
      renderStaffStockTable();
      renderAdminMenuTable();
    }
  }

  function renderPublicMenu() {
    const grid = document.getElementById('publicMenuGrid');
    if (!grid) return;

    const term = state.publicSearch.trim().toLowerCase();
    const filtered = state.menu.filter((item) => {
      const catOk = state.publicCategory === 'All' || item.category === state.publicCategory;
      const searchOk = !term ||
        item.name.toLowerCase().includes(term) ||
        item.description.toLowerCase().includes(term) ||
        item.category.toLowerCase().includes(term);
      return catOk && searchOk;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `<div class="card empty-cell" style="grid-column: 1 / -1;">No dishes match your filter. Try selecting "All" or clearing your search.</div>`;
      return;
    }

    grid.innerHTML = filtered.map((item) => {
      const imgSrc = escapeHTML(sanitizeImageSrc(item.image));
      const availBadge = item.available
        ? '<span class="status-pill pill-success">Available</span>'
        : '<span class="status-pill pill-danger">Out of Stock</span>';
      return `
        <article class="menu-card">
          <div class="menu-card-media" data-action="open-dish" data-id="${escapeHTML(item.id)}">
            <img src="${imgSrc}" alt="${escapeHTML(item.name)}" loading="lazy" referrerpolicy="no-referrer" data-fallback-img="true">
          </div>
          <div class="menu-card-body">
            <div class="menu-card-top">
              <span class="category-label">${escapeHTML(item.category)}</span>
              ${availBadge}
            </div>
            <h3 class="menu-card-title" data-action="open-dish" data-id="${escapeHTML(item.id)}">${escapeHTML(item.name)}</h3>
            <p class="menu-card-desc">${escapeHTML(item.description)}</p>
            <div class="menu-card-footer">
              <span class="menu-price tabular">${formatPeso(item.price)}</span>
              <button type="button" class="btn btn-primary btn-sm" data-action="add-public-cart" data-id="${escapeHTML(item.id)}" ${item.available ? '' : 'disabled'}>
                ${item.available ? '+ Add' : 'Unavailable'}
              </button>
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  function openDishDetail(itemId) {
    const item = state.menu.find((m) => String(m.id) === String(itemId));
    if (!item) return;

    state.activeDetailDishId = item.id;
    trackEvent({ type: 'menu_click', itemId: item.id, itemName: item.name, category: item.category });

    const img = document.getElementById('dishModalImg');
    img.src = sanitizeImageSrc(item.image);
    img.alt = item.name;
    img.onerror = () => {
      img.onerror = null;
      img.src = FALLBACK_IMG;
    };

    document.getElementById('dishModalCategory').textContent = item.category;
    const statusEl = document.getElementById('dishModalStatus');
    statusEl.textContent = item.available ? 'Available' : 'Out of Stock';
    statusEl.className = `status-pill ${item.available ? 'pill-success' : 'pill-danger'}`;
    document.getElementById('dishModalTitle').textContent = item.name;
    document.getElementById('dishModalDesc').textContent = item.description;
    document.getElementById('dishModalPrice').textContent = formatPeso(item.price);

    const addBtn = document.getElementById('dishModalAddBtn');
    addBtn.disabled = !item.available;
    addBtn.textContent = item.available ? 'Add to Order' : 'Out of Stock';

    openModal('dishDetailModal');
  }

  function addToPublicCart(itemId, logClick = true) {
    const item = state.menu.find((m) => String(m.id) === String(itemId));
    if (!item || !item.available) return;

    if (logClick) {
      trackEvent({ type: 'menu_click', itemId: item.id, itemName: item.name, category: item.category });
    }

    const existing = state.publicCart.find((c) => String(c.id) === String(item.id));
    if (existing) {
      existing.qty += 1;
    } else {
      state.publicCart.push({ id: item.id, name: item.name, price: item.price, qty: 1 });
    }
    renderPublicCart();
    showToast(`Added ${item.name}`);
  }

  function updatePublicCartQty(itemId, delta) {
    const idx = state.publicCart.findIndex((c) => String(c.id) === String(itemId));
    if (idx === -1) return;
    state.publicCart[idx].qty += delta;
    if (state.publicCart[idx].qty <= 0) {
      state.publicCart.splice(idx, 1);
    }
    renderPublicCart();
  }

  function renderPublicCart() {
    const listEl = document.getElementById('publicCartItems');
    const summaryEl = document.getElementById('cartItemSummary');
    const totalEl = document.getElementById('publicCartTotal');
    const navCountEl = document.getElementById('navCartCount');
    const placeBtn = document.getElementById('placeOrderBtn');
    const mobileBar = document.getElementById('mobileCartBar');
    const mobileBarText = document.getElementById('mobileCartBarText');

    const totalQty = state.publicCart.reduce((sum, i) => sum + i.qty, 0);
    const totalPrice = state.publicCart.reduce((sum, i) => sum + i.price * i.qty, 0);

    summaryEl.textContent = `${totalQty} ${totalQty === 1 ? 'item' : 'items'}`;
    totalEl.textContent = formatPeso(totalPrice);
    navCountEl.textContent = String(totalQty);
    placeBtn.disabled = totalQty === 0;

    if (totalQty > 0 && state.activeView === 'public') {
      mobileBarText.textContent = `Your Order (${totalQty}) · ${formatPeso(totalPrice)}`;
      mobileBar.classList.remove('hidden');
      document.body.classList.add('has-mobile-cart-bar');
    } else {
      mobileBar.classList.add('hidden');
      document.body.classList.remove('has-mobile-cart-bar');
    }

    if (state.publicCart.length === 0) {
      listEl.innerHTML = `<div class="cart-empty">Your order is empty. Tap "+ Add" on any dish to start.</div>`;
      return;
    }

    listEl.innerHTML = state.publicCart.map((c) => `
      <div class="cart-row">
        <div class="cart-row-info">
          <div class="cart-row-name">${escapeHTML(c.name)}</div>
          <div class="cart-row-price tabular">${formatPeso(c.price)} &times; ${c.qty} = ${formatPeso(c.price * c.qty)}</div>
        </div>
        <div class="qty-stepper">
          <button type="button" class="stepper-btn" data-action="pub-qty" data-id="${escapeHTML(c.id)}" data-delta="-1" aria-label="Decrease quantity">&minus;</button>
          <span class="stepper-qty tabular">${c.qty}</span>
          <button type="button" class="stepper-btn" data-action="pub-qty" data-id="${escapeHTML(c.id)}" data-delta="1" aria-label="Increase quantity">+</button>
        </div>
      </div>
    `).join('');
  }

  async function handlePublicCheckout(e) {
    e.preventDefault();
    if (state.publicCart.length === 0) return;

    const btn = document.getElementById('placeOrderBtn');
    const customerName = document.getElementById('custNameInput').value.trim();
    const tableNumber = document.getElementById('custTableInput').value.trim();

    if (!customerName) {
      showToast('Please enter your name.', 'error');
      return;
    }

    const elapsed = Math.round((Date.now() - state.menuStartTime) / 1000);
    const browseDurationSec = Math.min(3600, Math.max(3, elapsed));

    btn.disabled = true;
    btn.textContent = 'Placing Order...';

    try {
      const order = await apiFetch('./api/orders', {
        method: 'POST',
        body: {
          customerName,
          orderType: state.publicOrderType,
          tableNumber: state.publicOrderType === 'Dine-In' ? tableNumber : '',
          source: 'Online',
          browseDurationSec,
          items: state.publicCart.map((c) => ({ itemId: c.id, qty: c.qty }))
        }
      });

      state.publicCart = [];
      state.menuStartTime = Date.now();
      state.lastPlacedOrderId = order.id;
      document.getElementById('custNameInput').value = '';
      document.getElementById('custTableInput').value = '';

      saveRecentOrderId(order.id);
      renderPublicCart();
      closeCartDrawer();

      document.getElementById('confirmOrderIdText').textContent = order.id;
      openModal('orderConfirmModal');
    } catch (err) {
      showToast(err.message || 'Could not place order.', 'error');
    } finally {
      btn.disabled = state.publicCart.length === 0;
      btn.textContent = 'Place Order';
    }
  }

  function getRecentOrderIds() {
    try {
      const raw = localStorage.getItem(RECENT_ORDERS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.slice(0, 6) : [];
    } catch {
      return [];
    }
  }

  function saveRecentOrderId(orderId) {
    try {
      const existing = getRecentOrderIds().filter((id) => id !== orderId);
      existing.unshift(orderId);
      localStorage.setItem(RECENT_ORDERS_KEY, JSON.stringify(existing.slice(0, 6)));
    } catch {
      // Ignore storage quota errors
    }
    renderRecentOrderChips();
  }

  function renderRecentOrderChips() {
    const wrap = document.getElementById('recentOrdersWrap');
    const row = document.getElementById('recentOrdersChips');
    const ids = getRecentOrderIds();
    if (!wrap || !row) return;

    if (ids.length === 0) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    row.innerHTML = ids
      .map((id) => `<button type="button" class="order-chip tabular" data-action="track-chip" data-id="${escapeHTML(id)}">${escapeHTML(id)}</button>`)
      .join('');
  }

  async function trackOrderById(orderId) {
    const cleanId = String(orderId || '').trim().toUpperCase();
    const container = document.getElementById('trackResultContainer');
    const btn = document.getElementById('trackOrderBtn');
    if (!cleanId) return;

    document.getElementById('trackOrderIdInput').value = cleanId;
    btn.disabled = true;
    btn.textContent = 'Searching...';

    try {
      const order = await apiFetch(`./api/orders/track/${encodeURIComponent(cleanId)}`);
      renderTrackedOrder(order);
    } catch (err) {
      container.classList.remove('hidden');
      container.innerHTML = `<p class="form-error">${escapeHTML(err.message || 'Order not found.')}</p>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Track Order';
    }
  }

  function renderTrackedOrder(order) {
    const container = document.getElementById('trackResultContainer');
    const steps = ['Pending', 'Preparing', 'Ready', 'Completed'];
    const currentIdx = steps.indexOf(order.status);

    let progressHtml = '';
    if (order.status === 'Cancelled') {
      progressHtml = `<div class="form-error" style="margin-bottom: 16px;">This order was cancelled. Please contact our counter if you need assistance.</div>`;
    } else {
      progressHtml = `
        <div class="track-steps">
          ${steps.map((step, i) => {
            const cls = i < currentIdx ? 'done' : i === currentIdx ? 'current' : '';
            return `<div class="track-step ${cls}">${escapeHTML(step)}</div>`;
          }).join('')}
        </div>
      `;
    }

    const itemsHtml = (order.items || []).map((i) => `
      <li>
        <span>${i.qty}&times; ${escapeHTML(i.name)}</span>
        <strong class="tabular">${formatPeso(i.price * i.qty)}</strong>
      </li>
    `).join('');

    let ratingHtml = '';
    if (order.status === 'Completed') {
      if (order.rating) {
        ratingHtml = `
          <div class="rating-box">
            <strong>Thank you for rating your meal</strong>
            <p class="muted-text tabular" style="margin: 4px 0 0;">Your rating: ${'★'.repeat(order.rating)}${'☆'.repeat(5 - order.rating)} (${order.rating}/5)</p>
          </div>
        `;
      } else {
        ratingHtml = `
          <div class="rating-box">
            <strong>How was your Kusina Moderna meal?</strong>
            <p class="muted-text" style="margin: 4px 0 0;">Tap a star to submit your feedback.</p>
            <div class="star-row" role="group" aria-label="Rate this order from 1 to 5 stars">
              ${[1, 2, 3, 4, 5].map((n) => `
                <button type="button" class="star-btn" data-action="rate-order" data-id="${escapeHTML(order.id)}" data-rating="${n}" aria-label="Rate ${n} out of 5 stars">&#9733;</button>
              `).join('')}
            </div>
          </div>
        `;
      }
    }

    const typeMeta = order.orderType === 'Dine-In' && order.tableNumber
      ? `${order.orderType} · Table ${escapeHTML(order.tableNumber)}`
      : escapeHTML(order.orderType);

    container.classList.remove('hidden');
    container.innerHTML = `
      <div class="track-header-row">
        <div>
          <strong class="tabular" style="font-size: 1.15rem;">${escapeHTML(order.id)}</strong>
          <div class="muted-text">${escapeHTML(order.customerName)} &middot; ${typeMeta} &middot; ${escapeHTML(formatDisplayDateTime(order.createdAt))}</div>
        </div>
        <span class="status-pill ${getStatusPillClass(order.status)}">${escapeHTML(order.status)}</span>
      </div>
      ${progressHtml}
      <ul class="track-items-list">${itemsHtml}</ul>
      <div class="cart-total-row">
        <span>Total Paid</span>
        <strong class="tabular">${formatPeso(order.total)}</strong>
      </div>
      ${ratingHtml}
    `;
  }

  async function submitOrderRating(orderId, rating) {
    try {
      await apiFetch(`./api/orders/${encodeURIComponent(orderId)}/rate`, {
        method: 'PATCH',
        body: { rating: Number(rating) }
      });
      showToast(`Thank you for your ${rating}-star rating!`);
      await trackOrderById(orderId);
    } catch (err) {
      showToast(err.message || 'Could not submit rating.', 'error');
    }
  }

  /* 
   * 7. AUTHENTICATION & ROLE-BASED PORTAL ROUTING
   *  */

  function updatePublicNavAuthButton() {
    const btn = document.getElementById('openPortalOrLoginBtn');
    if (!btn) return;
    if (state.user) {
      btn.textContent = state.user.role === 'admin' ? 'Admin Portal' : 'Staff Portal';
    } else {
      btn.textContent = 'Staff / Admin Login';
    }
  }

  function updatePortalHeader() {
    if (!state.user) return;
    const roleLabel = state.user.role === 'admin' ? 'Admin / Owner Portal' : 'Staff / Cashier Portal';
    const shortRole = state.user.role === 'admin' ? 'Admin' : 'Staff';
    document.getElementById('portalRoleTitle').textContent = roleLabel;
    document.getElementById('portalUserLabel').textContent = `Signed in as ${state.user.username} · ${shortRole}`;
  }

  async function handleLoginSubmit(e) {
    e.preventDefault();
    const btn = document.getElementById('loginSubmitBtn');
    const errEl = document.getElementById('loginErrorMsg');
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;

    errEl.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'Signing in...';

    try {
      const res = await apiFetch('./api/auth/login', {
        method: 'POST',
        body: { username, password }
      });
      state.authToken = res.token;
      state.user = res.user;

      document.getElementById('loginForm').reset();
      closeAllModals();
      updatePublicNavAuthButton();
      enterPortal();
      showToast(`Welcome back, ${res.user.username}`);
    } catch (err) {
      errEl.textContent = err.message || 'Invalid username or password.';
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  }

  function enterPortal() {
    if (!state.user) {
      openModal('loginModal');
      return;
    }
    state.activeView = 'portal';
    closeCartDrawer();
    document.getElementById('publicView').classList.add('hidden');
    document.getElementById('portalView').classList.remove('hidden');
    document.getElementById('mobileCartBar').classList.add('hidden');
    document.body.classList.remove('has-mobile-cart-bar');

    updatePortalHeader();

    const isAdmin = state.user.role === 'admin';
    document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin));
    document.querySelectorAll('.staff-only').forEach((el) => el.classList.toggle('hidden', isAdmin));

    const defaultTab = isAdmin ? 'analytics' : 'pos';
    switchPortalTab(defaultTab);
  }

  function switchToPublicView() {
    state.activeView = 'public';
    document.getElementById('portalView').classList.add('hidden');
    document.getElementById('publicView').classList.remove('hidden');
    updatePublicNavAuthButton();
    renderPublicCart();
    loadMenu().catch(() => {});
  }

  function handleLogout() {
    state.authToken = null;
    state.user = null;
    state.posCart = [];
    destroyAllCharts();
    switchToPublicView();
    showToast('Signed out cleanly.');
  }

  async function switchPortalTab(tabId) {
    if (!state.user) return;
    const isAdmin = state.user.role === 'admin';
    const allowedTabs = isAdmin
      ? ['analytics', 'pos', 'orders', 'menu', 'accounts']
      : ['pos', 'orders', 'stock'];

    const targetTab = allowedTabs.includes(tabId) ? tabId : allowedTabs[0];
    state.activePortalTab = targetTab;

    document.querySelectorAll('.portal-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === targetTab);
    });
    document.querySelectorAll('.portal-panel').forEach((panel) => {
      panel.classList.toggle('hidden', panel.id !== `tab-${targetTab}`);
    });

    try {
      if (targetTab === 'analytics') {
        await loadAdminAnalytics();
        requestAnimationFrame(() => resizeAllCharts());
      } else if (targetTab === 'pos') {
        await loadMenu();
        renderPosMenu();
        renderPosCart();
      } else if (targetTab === 'orders') {
        await loadPortalOrders();
      } else if (targetTab === 'stock') {
        await loadMenu();
        renderStaffStockTable();
      } else if (targetTab === 'menu') {
        await loadMenu();
        renderAdminMenuTable();
      } else if (targetTab === 'accounts') {
        await loadAdminUsers();
      }
    } catch (err) {
      showToast(err.message || 'Could not load portal data.', 'error');
    }
  }

  /* 
   * 8. ADMIN OWNER ANALYTICS DASHBOARD (8 KPIs, 4 Charts, 4 Tables, Insights, CSV)
   *  */

  async function loadAdminAnalytics() {
    if (!state.user || state.user.role !== 'admin') return;
    const data = await apiFetch('./api/analytics');
    state.analyticsData = data;
    state.menu = Array.isArray(data.menu) ? data.menu : state.menu;
    state.orders = Array.isArray(data.orders) ? data.orders : state.orders;
    state.users = Array.isArray(data.users) ? data.users : state.users;
    renderAdminAnalytics();
  }

  function isWithinRange(isoTimestamp, range) {
    if (range === 'all') return true;
    const targetKey = getLocalDateKey(isoTimestamp);
    if (!targetKey) return false;
    const now = new Date();
    const todayKey = getLocalDateKey(now);
    if (range === 'today') return targetKey === todayKey;
    if (range === '7d') {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
      const startKey = getLocalDateKey(start);
      return targetKey >= startKey && targetKey <= todayKey;
    }
    return true;
  }

  function renderAdminAnalytics() {
    const raw = state.analyticsData;
    if (!raw) return;

    const range = state.analyticsRange;
    const allOrders = Array.isArray(raw.orders) ? raw.orders : [];
    const menuItems = Array.isArray(raw.menu) ? raw.menu : [];
    const tracking = raw.tracking || { pageViews: [], menuClicks: [] };
    const dailyTarget = Number(raw.settings?.dailyTarget) || 6000;

    // 1. Daily Revenue Target (Always measures TODAY's non-cancelled revenue)
    const todayKey = getLocalDateKey(new Date());
    const todayRevenue = allOrders
      .filter((o) => o.status !== 'Cancelled' && getLocalDateKey(o.createdAt) === todayKey)
      .reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    const targetPct = dailyTarget > 0 ? Math.round((todayRevenue / dailyTarget) * 100) : 0;

    document.getElementById('targetTodayRev').textContent = formatPeso(todayRevenue);
    document.getElementById('targetGoalDisplay').textContent = formatPeso(dailyTarget);
    document.getElementById('dailyTargetInput').value = String(dailyTarget);
    const pctBadge = document.getElementById('targetPercentBadge');
    pctBadge.textContent = `${targetPct}%`;
    pctBadge.className = `status-pill ${targetPct >= 100 ? 'pill-success' : targetPct >= 50 ? 'pill-warning' : 'pill-neutral'}`;
    const bar = document.getElementById('targetProgressBar');
    bar.style.width = `${Math.min(100, targetPct)}%`;
    bar.classList.toggle('achieved', targetPct >= 100);

    // 2. Filter Orders & Behavioral Telemetry by Selected Timeframe
    const filteredOrders = allOrders.filter((o) => isWithinRange(o.createdAt, range));
    const validOrders = filteredOrders.filter((o) => o.status !== 'Cancelled');
    const cancelledOrders = filteredOrders.filter((o) => o.status === 'Cancelled');
    const filteredViews = (tracking.pageViews || []).filter((v) => isWithinRange(v.timestamp, range));
    const filteredClicks = (tracking.menuClicks || []).filter((c) => isWithinRange(c.timestamp, range));

    // 3. Financial KPIs
    const grossRevenue = validOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    const totalCost = validOrders.reduce((sum, o) => sum + (Number(o.totalCost) || 0), 0);
    const netProfit = grossRevenue - totalCost;
    const marginPct = grossRevenue > 0 ? (netProfit / grossRevenue) * 100 : 0;
    const cancelledLost = cancelledOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    const aov = validOrders.length > 0 ? grossRevenue / validOrders.length : 0;
    const highestOrder = validOrders.reduce((max, o) => Math.max(max, Number(o.total) || 0), 0);

    document.getElementById('kpiRevenue').textContent = formatPeso(grossRevenue);
    document.getElementById('kpiRevenueNote').textContent = `Across ${validOrders.length} active/completed orders`;
    document.getElementById('kpiProfit').textContent = formatPeso(netProfit);
    document.getElementById('kpiMarginNote').textContent = `${marginPct.toFixed(1)}% gross margin`;
    document.getElementById('kpiOrders').textContent = String(validOrders.length);
    document.getElementById('kpiCancelledNote').textContent = `${cancelledOrders.length} cancelled (${formatPeso(cancelledLost)} lost)`;
    document.getElementById('kpiAov').textContent = formatPeso(aov);
    document.getElementById('kpiHighestNote').textContent = `Highest order: ${formatPeso(highestOrder)}`;

    // 4. Customer Behavior KPIs
    const pageViewsCount = filteredViews.length;
    const onlineValidOrders = validOrders.filter((o) => o.source === 'Online');
    const conversionPct = pageViewsCount > 0 ? (onlineValidOrders.length / pageViewsCount) * 100 : 0;

    // Dish click counts & sales metrics
    const dishStatsMap = new Map();
    for (const m of menuItems) {
      dishStatsMap.set(String(m.id), {
        id: String(m.id),
        name: m.name,
        category: m.category,
        clicks: 0,
        units: 0,
        revenue: 0,
        cost: 0,
        profit: 0
      });
    }

    for (const clk of filteredClicks) {
      const key = String(clk.itemId || clk.itemName);
      if (!dishStatsMap.has(key)) {
        dishStatsMap.set(key, {
          id: key,
          name: clk.itemName || 'Unknown Dish',
          category: clk.category || 'Mains',
          clicks: 0,
          units: 0,
          revenue: 0,
          cost: 0,
          profit: 0
        });
      }
      dishStatsMap.get(key).clicks += 1;
    }

    for (const ord of validOrders) {
      for (const it of ord.items || []) {
        const key = String(it.itemId || it.name);
        if (!dishStatsMap.has(key)) {
          dishStatsMap.set(key, {
            id: key,
            name: it.name,
            category: it.category || 'Mains',
            clicks: 0,
            units: 0,
            revenue: 0,
            cost: 0,
            profit: 0
          });
        }
        const stat = dishStatsMap.get(key);
        const qty = Number(it.qty) || 0;
        const lineRev = (Number(it.price) || 0) * qty;
        const lineCost = (Number(it.cost) || 0) * qty;
        stat.units += qty;
        stat.revenue += lineRev;
        stat.cost += lineCost;
        stat.profit += lineRev - lineCost;
      }
    }

    const dishStats = Array.from(dishStatsMap.values());
    const topClickedDish = [...dishStats].sort((a, b) => b.clicks - a.clicks)[0];

    // Browse times (Online orders with recorded duration)
    const browseSecs = validOrders
      .map((o) => o.browseDurationSec)
      .filter((s) => s !== null && s !== undefined && Number.isFinite(Number(s)))
      .map(Number);
    const avgBrowse = browseSecs.length > 0
      ? browseSecs.reduce((sum, s) => sum + s, 0) / browseSecs.length
      : null;
    const minBrowse = browseSecs.length > 0 ? Math.min(...browseSecs) : null;
    const maxBrowse = browseSecs.length > 0 ? Math.max(...browseSecs) : null;

    // Peak Hour & Average Rating
    const hourCounts = new Array(24).fill(0);
    for (const ord of validOrders) {
      const dt = new Date(ord.createdAt);
      if (!Number.isNaN(dt.getTime())) {
        hourCounts[dt.getHours()] += 1;
      }
    }
    let peakHour = -1;
    let peakCount = 0;
    hourCounts.forEach((cnt, hr) => {
      if (cnt > peakCount) {
        peakCount = cnt;
        peakHour = hr;
      }
    });

    const ratedOrders = validOrders.filter((o) => Number.isFinite(Number(o.rating)) && Number(o.rating) > 0);
    const avgRating = ratedOrders.length > 0
      ? ratedOrders.reduce((s, o) => s + Number(o.rating), 0) / ratedOrders.length
      : null;

    document.getElementById('kpiPageViews').textContent = String(pageViewsCount);
    document.getElementById('kpiConversionNote').textContent = `${conversionPct.toFixed(1)}% online visitor-to-order rate`;
    document.getElementById('kpiMenuClicks').textContent = String(filteredClicks.length);
    document.getElementById('kpiTopClickedNote').textContent = topClickedDish && topClickedDish.clicks > 0
      ? `Top clicked: ${topClickedDish.name} (${topClickedDish.clicks})`
      : 'Top clicked: —';
    document.getElementById('kpiBrowseTime').textContent = formatDuration(avgBrowse);
    document.getElementById('kpiBrowseRangeNote').textContent = `Fastest: ${formatDuration(minBrowse)} · Longest: ${formatDuration(maxBrowse)}`;
    document.getElementById('kpiPeakHour').textContent = peakHour >= 0 ? formatHourRange(peakHour) : '—';
    document.getElementById('kpiRatingNote').textContent = avgRating !== null
      ? `★ ${avgRating.toFixed(1)} avg. across ${ratedOrders.length} rated orders`
      : 'No ratings in selected period';

    // 5. Daily Revenue/Profit & Daily Best-Sellers
    const dayMap = new Map();
    for (const ord of validOrders) {
      const dk = getLocalDateKey(ord.createdAt);
      if (!dk) continue;
      if (!dayMap.has(dk)) {
        dayMap.set(dk, { dateKey: dk, orders: 0, revenue: 0, profit: 0, dishCounts: new Map() });
      }
      const entry = dayMap.get(dk);
      entry.orders += 1;
      entry.revenue += Number(ord.total) || 0;
      entry.profit += (Number(ord.total) || 0) - (Number(ord.totalCost) || 0);
      for (const it of ord.items || []) {
        const cur = entry.dishCounts.get(it.name) || { name: it.name, qty: 0, rev: 0 };
        cur.qty += Number(it.qty) || 0;
        cur.rev += (Number(it.price) || 0) * (Number(it.qty) || 0);
        entry.dishCounts.set(it.name, cur);
      }
    }

    const dailyAsc = Array.from(dayMap.values()).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    const dailyDesc = [...dailyAsc].reverse();

    // Category Revenue Map
    const catRevMap = new Map();
    for (const d of dishStats) {
      if (d.revenue > 0) {
        catRevMap.set(d.category, (catRevMap.get(d.category) || 0) + d.revenue);
      }
    }

    // 6. Automated Owner Insights (5 dynamic BA recommendations)
    const sortedByRev = [...dishStats].sort((a, b) => b.revenue - a.revenue);
    const topRevDish = sortedByRev[0];
    const highestConvDish = [...dishStats]
      .filter((d) => d.clicks >= 2)
      .sort((a, b) => (b.units / b.clicks) - (a.units / a.clicks))[0];
    const highClickLowOrder = [...dishStats]
      .filter((d) => d.clicks >= 3)
      .sort((a, b) => (a.units / a.clicks) - (b.units / b.clicks))[0];

    const walkInCount = validOrders.filter((o) => o.source === 'Walk-In POS').length;
    const onlinePct = validOrders.length > 0 ? Math.round((onlineValidOrders.length / validOrders.length) * 100) : 0;

    const insights = [];
    if (topRevDish && topRevDish.revenue > 0) {
      const share = grossRevenue > 0 ? ((topRevDish.revenue / grossRevenue) * 100).toFixed(1) : '0.0';
      insights.push(`${topRevDish.name} leads revenue at ${formatPeso(topRevDish.revenue)} (${share}% of gross sales, ${topRevDish.units} units sold). Keep core ingredients stocked ahead of peak shifts.`);
    } else {
      insights.push('Record or receive your first order in this timeframe to unlock top-revenue dish analysis.');
    }

    if (topClickedDish && topClickedDish.clicks > 0 && highestConvDish) {
      const conv = ((highestConvDish.units / highestConvDish.clicks) * 100).toFixed(0);
      insights.push(`Highest menu curiosity goes to ${topClickedDish.name} (${topClickedDish.clicks} clicks), while ${highestConvDish.name} converts interest most effectively at ${conv}% click-to-order.`);
    } else {
      insights.push('As customers explore dishes on the public storefront, click-to-order conversion leaders will appear here.');
    }

    if (avgBrowse !== null) {
      insights.push(`Online diners spend an average of ${formatDuration(avgBrowse)} checking the menu before submitting checkout (range: ${formatDuration(minBrowse)} to ${formatDuration(maxBrowse)}).`);
    } else {
      insights.push('No online browse duration samples recorded for this timeframe yet.');
    }

    if (peakHour >= 0) {
      insights.push(`Peak kitchen demand occurs around ${formatHourRange(peakHour)} (${peakCount} orders). Channel mix is ${onlinePct}% Online (${onlineValidOrders.length}) vs. ${100 - onlinePct}% Walk-In POS (${walkInCount}).`);
    } else {
      insights.push('Hourly peak demand and channel mix will populate once orders are recorded in this timeframe.');
    }

    if (highClickLowOrder) {
      const lowRate = ((highClickLowOrder.units / highClickLowOrder.clicks) * 100).toFixed(0);
      insights.push(`Optimization opportunity: ${highClickLowOrder.name} attracted ${highClickLowOrder.clicks} clicks but converted at ${lowRate}% (${highClickLowOrder.units} sold). Consider highlighting its pairing or testing a bundle price.`);
    } else {
      const lowestSold = [...dishStats].sort((a, b) => a.units - b.units)[0];
      insights.push(lowestSold
        ? `Optimization opportunity: ${lowestSold.name} has the lowest order volume (${lowestSold.units} sold). Feature it in staff recommendations during slower afternoon hours.`
        : 'All menu items are balanced in the current period.');
    }

    document.getElementById('insightsList').innerHTML = insights
      .map((text, idx) => `<li><span class="insight-index">0${idx + 1}.</span><span>${escapeHTML(text)}</span></li>`)
      .join('');

    // 7. Render 4 Analytical Tables
    renderDailyBestSellersTable(dailyDesc);
    renderMenuProfitabilityTable(sortedByRev);
    renderCustomerSpendTable(validOrders);
    renderStaffPerformanceTable(validOrders);

    // 8. Save snapshot for CSV exports
    state.computedAnalytics = {
      filteredOrders,
      dishStats: sortedByRev
    };

    // 9. Render 4 Responsive Monochrome Chart.js Visualizations
    renderAnalyticsCharts(dailyAsc, dishStats, catRevMap, hourCounts);
  }

  function renderDailyBestSellersTable(dailyDesc) {
    const tbody = document.getElementById('dailyBestSellersBody');
    if (dailyDesc.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">No completed or active orders in this timeframe.</td></tr>`;
      return;
    }

    tbody.innerHTML = dailyDesc.map((day) => {
      const topDish = Array.from(day.dishCounts.values()).sort((a, b) => b.qty - a.qty || b.rev - a.rev)[0];
      return `
        <tr>
          <td class="tabular">${escapeHTML(formatShortDate(day.dateKey))}</td>
          <td><strong>${escapeHTML(topDish ? topDish.name : '—')}</strong></td>
          <td class="num">${topDish ? topDish.qty : 0}</td>
          <td class="num">${formatPeso(topDish ? topDish.rev : 0)}</td>
          <td class="num">${day.orders}</td>
          <td class="num"><strong>${formatPeso(day.revenue)}</strong></td>
        </tr>
      `;
    }).join('');
  }

  function renderMenuProfitabilityTable(sortedByRev) {
    const tbody = document.getElementById('menuProfitabilityBody');
    if (sortedByRev.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-cell">No menu performance data available.</td></tr>`;
      return;
    }

    tbody.innerHTML = sortedByRev.map((d) => {
      const clickConv = d.clicks > 0 ? `${((d.units / d.clicks) * 100).toFixed(1)}%` : '—';
      const margin = d.revenue > 0 ? `${((d.profit / d.revenue) * 100).toFixed(1)}%` : '—';
      return `
        <tr>
          <td><strong>${escapeHTML(d.name)}</strong></td>
          <td class="muted-text">${escapeHTML(d.category)}</td>
          <td class="num">${d.clicks}</td>
          <td class="num">${d.units}</td>
          <td class="num">${clickConv}</td>
          <td class="num">${formatPeso(d.revenue)}</td>
          <td class="num" style="color: var(--sage);">${formatPeso(d.profit)}</td>
          <td class="num">${margin}</td>
        </tr>
      `;
    }).join('');
  }

  function renderCustomerSpendTable(validOrders) {
    const tbody = document.getElementById('customerSpendBody');
    const custMap = new Map();

    for (const ord of validOrders) {
      const name = (ord.customerName || 'Walk-in').trim();
      const key = name.toLowerCase();
      if (!custMap.has(key)) {
        custMap.set(key, { name, orders: 0, totalSpent: 0, browseTimes: [], dishQty: new Map() });
      }
      const c = custMap.get(key);
      c.orders += 1;
      c.totalSpent += Number(ord.total) || 0;
      if (ord.browseDurationSec !== null && ord.browseDurationSec !== undefined) {
        c.browseTimes.push(Number(ord.browseDurationSec));
      }
      for (const it of ord.items || []) {
        c.dishQty.set(it.name, (c.dishQty.get(it.name) || 0) + (Number(it.qty) || 0));
      }
    }

    const rows = Array.from(custMap.values()).sort((a, b) => b.totalSpent - a.totalSpent);
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">No customer orders in this timeframe.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((c) => {
      const avgSpend = c.orders > 0 ? c.totalSpent / c.orders : 0;
      const avgTime = c.browseTimes.length > 0
        ? c.browseTimes.reduce((s, v) => s + v, 0) / c.browseTimes.length
        : null;
      const fav = Array.from(c.dishQty.entries()).sort((a, b) => b[1] - a[1])[0];
      return `
        <tr>
          <td><strong>${escapeHTML(c.name)}</strong></td>
          <td class="num">${c.orders}</td>
          <td class="num"><strong>${formatPeso(c.totalSpent)}</strong></td>
          <td class="num">${formatPeso(avgSpend)}</td>
          <td class="num">${formatDuration(avgTime)}</td>
          <td>${escapeHTML(fav ? fav[0] : '—')}</td>
        </tr>
      `;
    }).join('');
  }

  function renderStaffPerformanceTable(validOrders) {
    const tbody = document.getElementById('staffPerformanceBody');
    const staffMap = new Map();

    for (const ord of validOrders) {
      const handler = ord.source === 'Online' ? 'Online Self-Order' : (ord.recordedBy || 'Staff');
      const channel = ord.source === 'Online' ? 'Online' : 'Walk-In POS';
      const key = `${handler}|${channel}`;
      if (!staffMap.has(key)) {
        staffMap.set(key, { handler, channel, orders: 0, revenue: 0 });
      }
      const row = staffMap.get(key);
      row.orders += 1;
      row.revenue += Number(ord.total) || 0;
    }

    const rows = Array.from(staffMap.values()).sort((a, b) => b.revenue - a.revenue);
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-cell">No channel performance data in this timeframe.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td><strong>${escapeHTML(r.handler)}</strong></td>
        <td><span class="status-pill ${r.channel === 'Online' ? 'pill-neutral' : 'pill-success'}">${escapeHTML(r.channel)}</span></td>
        <td class="num">${r.orders}</td>
        <td class="num"><strong>${formatPeso(r.revenue)}</strong></td>
      </tr>
    `).join('');
  }

  function destroyAllCharts() {
    Object.keys(state.charts).forEach((key) => {
      if (state.charts[key]) {
        state.charts[key].destroy();
        state.charts[key] = null;
      }
    });
  }

  function resizeAllCharts() {
    Object.values(state.charts).forEach((chart) => {
      if (chart && typeof chart.resize === 'function') {
        chart.resize();
      }
    });
  }

  function ensureAnalyticsResizeObserver() {
    if (typeof window.ResizeObserver !== 'function') return;
    const container = document.getElementById('tab-analytics');
    if (!container) return;

    if (state.analyticsResizeObserver) {
      state.analyticsResizeObserver.disconnect();
      state.analyticsResizeObserver = null;
    }

    let observerTimer = null;
    state.analyticsResizeObserver = new window.ResizeObserver(() => {
      if (state.activeView !== 'portal' || state.activePortalTab !== 'analytics') return;
      clearTimeout(observerTimer);
      observerTimer = setTimeout(() => {
        const nowNarrow = window.innerWidth < 640;
        if (state.lastChartNarrowMode !== null && state.lastChartNarrowMode !== nowNarrow && state.analyticsData) {
          renderAdminAnalytics();
        } else {
          resizeAllCharts();
        }
      }, 100);
    });

    state.analyticsResizeObserver.observe(container);
  }

  function renderAnalyticsCharts(dailyAsc, dishStats, catRevMap, hourCounts) {
    if (typeof window.Chart !== 'function') return;
    destroyAllCharts();

    const isNarrow = window.innerWidth < 640;
    state.lastChartNarrowMode = isNarrow;

    const family = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Helvetica, Arial, sans-serif';
    const gridColor = 'rgba(0, 0, 0, 0.06)';
    const tickColor = '#6E6E73';
    const tickFontSize = 11;
    const compactLegend = {
      position: 'bottom',
      labels: {
        boxWidth: 12,
        padding: 10,
        font: { family, size: 11 },
        color: '#1D1D1F'
      }
    };

    // 1. Daily Revenue vs Est. Profit Combo Chart
    const revCanvas = document.getElementById('revenueChart');
    if (revCanvas) {
      const labels = dailyAsc.length
        ? dailyAsc.map((d) => (isNarrow ? formatCompactChartDate(d.dateKey) : formatShortDate(d.dateKey)))
        : ['No Data'];
      const revVals = dailyAsc.length ? dailyAsc.map((d) => d.revenue) : [0];
      const profVals = dailyAsc.length ? dailyAsc.map((d) => d.profit) : [0];

      state.charts.revenueChart = new window.Chart(revCanvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              type: 'bar',
              label: isNarrow ? 'Revenue (₱)' : 'Gross Revenue (₱)',
              data: revVals,
              backgroundColor: '#1D1D1F',
              borderRadius: 6,
              maxBarThickness: isNarrow ? 26 : 38
            },
            {
              type: 'line',
              label: isNarrow ? 'Net Profit (₱)' : 'Est. Net Profit (₱)',
              data: profVals,
              borderColor: '#2E7D52',
              backgroundColor: '#2E7D52',
              borderWidth: 2.5,
              tension: 0.3,
              pointRadius: isNarrow ? 3 : 4
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          resizeDelay: 100,
          layout: { padding: { top: 4, right: 6, bottom: 0, left: 0 } },
          plugins: { legend: compactLegend },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                color: tickColor,
                maxRotation: 0,
                autoSkip: true,
                font: { family, size: tickFontSize }
              }
            },
            y: {
              beginAtZero: true,
              grid: { color: gridColor },
              ticks: {
                color: tickColor,
                font: { family, size: tickFontSize }
              }
            }
          }
        }
      });
    }

    // 2. Most Clicked vs Most Ordered (Top 6 Grouped Horizontal Bar)
    const engCanvas = document.getElementById('engagementChart');
    if (engCanvas) {
      const top6 = [...dishStats]
        .sort((a, b) => (b.clicks + b.units) - (a.clicks + a.units))
        .slice(0, 6);
      const maxLabelChars = isNarrow ? 15 : 22;
      const labels = top6.length
        ? top6.map((d) => truncateChartLabel(d.name, maxLabelChars))
        : ['No Data'];

      state.charts.engagementChart = new window.Chart(engCanvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Menu Clicks',
              data: top6.length ? top6.map((d) => d.clicks) : [0],
              backgroundColor: '#B0B0B5',
              borderRadius: 5
            },
            {
              label: 'Units Ordered',
              data: top6.length ? top6.map((d) => d.units) : [0],
              backgroundColor: '#1D1D1F',
              borderRadius: 5
            }
          ]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          resizeDelay: 100,
          layout: { padding: { top: 4, right: 8, bottom: 0, left: 0 } },
          plugins: { legend: compactLegend },
          scales: {
            x: {
              beginAtZero: true,
              grid: { color: gridColor },
              ticks: {
                precision: 0,
                maxRotation: 0,
                autoSkip: true,
                color: tickColor,
                font: { family, size: tickFontSize }
              }
            },
            y: {
              grid: { display: false },
              ticks: {
                autoSkip: false,
                color: '#1D1D1F',
                font: { family, size: tickFontSize }
              }
            }
          }
        }
      });
    }

    // 3. Revenue Share by Category (Monochrome Doughnut)
    const catCanvas = document.getElementById('categoryChart');
    if (catCanvas) {
      const entries = Array.from(catRevMap.entries());
      const hasData = entries.length > 0;
      state.charts.categoryChart = new window.Chart(catCanvas, {
        type: 'doughnut',
        data: {
          labels: hasData ? entries.map((e) => e[0]) : ['No Sales Yet'],
          datasets: [{
            data: hasData ? entries.map((e) => e[1]) : [1],
            backgroundColor: hasData ? ['#1D1D1F', '#515154', '#86868B', '#C7C7CC'] : ['#E5E5EA'],
            borderWidth: 2,
            borderColor: '#FFFFFF'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          resizeDelay: 100,
          layout: { padding: 8 },
          cutout: '62%',
          plugins: {
            legend: compactLegend
          }
        }
      });
    }

    // 4. Hourly Order Volume (Peak Hours Bar Chart)
    const hrCanvas = document.getElementById('hourlyChart');
    if (hrCanvas) {
      const activeHours = [];
      for (let h = 9; h <= 21; h += 1) {
        activeHours.push(h);
      }
      // Include any off-hours that actually have orders
      hourCounts.forEach((cnt, h) => {
        if (cnt > 0 && !activeHours.includes(h)) activeHours.push(h);
      });
      activeHours.sort((a, b) => a - b);

      const hourLabels = activeHours.map((h) => {
        if (!isNarrow) return formatHourLabel(h);
        const suffix = h >= 12 ? 'p' : 'a';
        const display = h % 12 === 0 ? 12 : h % 12;
        return `${display}${suffix}`;
      });

      state.charts.hourlyChart = new window.Chart(hrCanvas, {
        type: 'bar',
        data: {
          labels: hourLabels,
          datasets: [{
            label: 'Orders',
            data: activeHours.map((h) => hourCounts[h]),
            backgroundColor: '#515154',
            hoverBackgroundColor: '#1D1D1F',
            borderRadius: 6,
            maxBarThickness: isNarrow ? 18 : 28
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          resizeDelay: 100,
          layout: { padding: { top: 4, right: 6, bottom: 0, left: 0 } },
          plugins: { legend: { display: false } },
          scales: {
            x: {
              grid: { display: false },
              ticks: {
                color: tickColor,
                maxRotation: 0,
                autoSkip: true,
                maxTicksLimit: isNarrow ? 7 : 13,
                font: { family, size: tickFontSize }
              }
            },
            y: {
              beginAtZero: true,
              grid: { color: gridColor },
              ticks: {
                precision: 0,
                color: tickColor,
                font: { family, size: tickFontSize }
              }
            }
          }
        }
      });
    }

    ensureAnalyticsResizeObserver();
    requestAnimationFrame(() => resizeAllCharts());
  }

  async function handleSaveDailyTarget(e) {
    e.preventDefault();
    const input = document.getElementById('dailyTargetInput');
    const btn = document.getElementById('saveTargetBtn');
    const val = Number(input.value);
    if (!Number.isFinite(val) || val <= 0) {
      showToast('Enter a valid target greater than 0.', 'error');
      return;
    }

    btn.disabled = true;
    try {
      const updated = await apiFetch('./api/settings', {
        method: 'PUT',
        body: { dailyTarget: val }
      });
      if (state.analyticsData) state.analyticsData.settings = updated;
      renderAdminAnalytics();
      showToast('Daily revenue target updated.');
    } catch (err) {
      showToast(err.message || 'Failed to update target.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // Excel-Safe UTF-8 BOM CSV Download
  function csvCell(val) {
    const str = String(val ?? '');
    return `"${str.replace(/"/g, '""')}"`;
  }

  function downloadCsvFile(filename, headers, rows) {
    const lines = [headers.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push(r.map(csvCell).join(','));
    }
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportTransactionsCsv() {
    const snap = state.computedAnalytics;
    if (!snap) return;
    const headers = [
      'Order ID', 'Date', 'Time', 'Customer', 'Source', 'Order Type', 'Table #',
      'Items', 'Total (PHP)', 'Est. Cost (PHP)', 'Est. Profit (PHP)',
      'Menu Browse Time (sec)', 'Status', 'Rating', 'Recorded By'
    ];
    const rows = snap.filteredOrders.map((o) => {
      const dt = new Date(o.createdAt);
      const dateStr = getLocalDateKey(dt);
      const timeStr = Number.isNaN(dt.getTime()) ? '' : dt.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
      const itemsText = (o.items || []).map((i) => `${i.qty}x ${i.name}`).join('; ');
      const total = Number(o.total) || 0;
      const cost = Number(o.totalCost) || 0;
      const profit = o.status === 'Cancelled' ? 0 : total - cost;
      return [
        o.id, dateStr, timeStr, o.customerName, o.source, o.orderType, o.tableNumber || '',
        itemsText, total.toFixed(2), cost.toFixed(2), profit.toFixed(2),
        o.browseDurationSec ?? '', o.status, o.rating ?? '', o.recordedBy || o.source
      ];
    });
    downloadCsvFile(`kusina-moderna-transactions-${state.analyticsRange}.csv`, headers, rows);
    showToast('Transactions CSV downloaded.');
  }

  function exportMenuEngagementCsv() {
    const snap = state.computedAnalytics;
    if (!snap) return;
    const headers = [
      'Dish Name', 'Category', 'Menu Clicks', 'Units Sold',
      'Click-to-Order %', 'Gross Revenue (PHP)', 'Est. Profit (PHP)', 'Margin %'
    ];
    const rows = snap.dishStats.map((d) => [
      d.name,
      d.category,
      d.clicks,
      d.units,
      d.clicks > 0 ? ((d.units / d.clicks) * 100).toFixed(1) : '0.0',
      d.revenue.toFixed(2),
      d.profit.toFixed(2),
      d.revenue > 0 ? ((d.profit / d.revenue) * 100).toFixed(1) : '0.0'
    ]);
    downloadCsvFile(`kusina-moderna-menu-engagement-${state.analyticsRange}.csv`, headers, rows);
    showToast('Menu Engagement & Sales CSV downloaded.');
  }

  /* ==========================================================================
   * 9. WALK-IN POS (STAFF & ADMIN)
   * ======================================================================== */

  function renderPosMenu() {
    const grid = document.getElementById('posMenuGrid');
    if (!grid) return;

    const term = state.posSearch.trim().toLowerCase();
    const filtered = state.menu.filter((item) => {
      const catOk = state.posCategory === 'All' || item.category === state.posCategory;
      const searchOk = !term || item.name.toLowerCase().includes(term) || item.category.toLowerCase().includes(term);
      return catOk && searchOk;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `<div class="card empty-cell" style="grid-column: 1 / -1;">No dishes match your search.</div>`;
      return;
    }

    grid.innerHTML = filtered.map((item) => `
      <div class="pos-item-card">
        <div class="menu-card-top">
          <span class="category-label">${escapeHTML(item.category)}</span>
          <span class="status-pill ${item.available ? 'pill-success' : 'pill-danger'}">${item.available ? 'In Stock' : 'Out'}</span>
        </div>
        <div class="pos-item-name">${escapeHTML(item.name)}</div>
        <div class="pos-item-footer">
          <strong class="tabular">${formatPeso(item.price)}</strong>
          <button type="button" class="btn btn-primary btn-sm" data-action="add-pos-cart" data-id="${escapeHTML(item.id)}" ${item.available ? '' : 'disabled'}>+ Add</button>
        </div>
      </div>
    `).join('');
  }

  function addToPosCart(itemId) {
    const item = state.menu.find((m) => String(m.id) === String(itemId));
    if (!item || !item.available) return;
    const existing = state.posCart.find((c) => String(c.id) === String(item.id));
    if (existing) existing.qty += 1;
    else state.posCart.push({ id: item.id, name: item.name, price: item.price, qty: 1 });
    renderPosCart();
  }

  function updatePosCartQty(itemId, delta) {
    const idx = state.posCart.findIndex((c) => String(c.id) === String(itemId));
    if (idx === -1) return;
    state.posCart[idx].qty += delta;
    if (state.posCart[idx].qty <= 0) state.posCart.splice(idx, 1);
    renderPosCart();
  }

  function renderPosCart() {
    const listEl = document.getElementById('posCartItems');
    const countEl = document.getElementById('posCartCount');
    const totalEl = document.getElementById('posCartTotal');
    const saveBtn = document.getElementById('savePosOrderBtn');

    const totalQty = state.posCart.reduce((s, c) => s + c.qty, 0);
    const total = state.posCart.reduce((s, c) => s + c.price * c.qty, 0);

    countEl.textContent = `${totalQty} ${totalQty === 1 ? 'item' : 'items'}`;
    totalEl.textContent = formatPeso(total);
    saveBtn.disabled = totalQty === 0;

    if (state.posCart.length === 0) {
      listEl.innerHTML = `<div class="cart-empty">Select items on the left to build a walk-in counter ticket.</div>`;
      return;
    }

    listEl.innerHTML = state.posCart.map((c) => `
      <div class="cart-row">
        <div class="cart-row-info">
          <div class="cart-row-name">${escapeHTML(c.name)}</div>
          <div class="cart-row-price tabular">${formatPeso(c.price * c.qty)}</div>
        </div>
        <div class="qty-stepper">
          <button type="button" class="stepper-btn" data-action="pos-qty" data-id="${escapeHTML(c.id)}" data-delta="-1" aria-label="Decrease">&minus;</button>
          <span class="stepper-qty tabular">${c.qty}</span>
          <button type="button" class="stepper-btn" data-action="pos-qty" data-id="${escapeHTML(c.id)}" data-delta="1" aria-label="Increase">+</button>
        </div>
      </div>
    `).join('');
  }

  async function handlePosCheckout(e) {
    e.preventDefault();
    if (state.posCart.length === 0) return;

    const btn = document.getElementById('savePosOrderBtn');
    const customerName = document.getElementById('posCustomerName').value.trim() || 'Walk-in';
    const tableNumber = document.getElementById('posTableInput').value.trim();

    btn.disabled = true;
    btn.textContent = 'Saving Order...';

    try {
      const created = await apiFetch('./api/orders', {
        method: 'POST',
        body: {
          customerName,
          orderType: state.posOrderType,
          tableNumber: state.posOrderType === 'Dine-In' ? tableNumber : '',
          source: 'Walk-In POS',
          browseDurationSec: null,
          items: state.posCart.map((c) => ({ itemId: c.id, qty: c.qty }))
        }
      });

      state.posCart = [];
      document.getElementById('posCustomerName').value = 'Walk-in';
      document.getElementById('posTableInput').value = '';
      renderPosCart();
      showToast(`Recorded ${created.id} (${formatPeso(created.total)})`);
      openReceiptModal(created);
    } catch (err) {
      showToast(err.message || 'Could not save walk-in order.', 'error');
    } finally {
      btn.disabled = state.posCart.length === 0;
      btn.textContent = 'Save Walk-In Order';
    }
  }

  /* ==========================================================================
   * 10. LIVE ORDER QUEUE & RECEIPT MODAL
   * ======================================================================== */

  async function loadPortalOrders() {
    const orders = await apiFetch('./api/orders');
    state.orders = Array.isArray(orders) ? orders : [];
    renderOrdersTable();
  }

  function renderOrdersTable() {
    const tbody = document.getElementById('ordersTableBody');
    if (!tbody) return;

    const isAdmin = state.user?.role === 'admin';
    const term = state.orderSearch.trim().toLowerCase();
    const filtered = state.orders.filter((o) => {
      const statusOk = state.orderStatusFilter === 'All' || o.status === state.orderStatusFilter;
      const sourceOk = !isAdmin || state.orderSourceFilter === 'All' || o.source === state.orderSourceFilter;
      const searchOk = !term ||
        String(o.id).toLowerCase().includes(term) ||
        String(o.customerName).toLowerCase().includes(term);
      return statusOk && sourceOk && searchOk;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-cell">No orders match the selected filters.</td></tr>`;
      return;
    }

    const statuses = ['Pending', 'Preparing', 'Ready', 'Completed', 'Cancelled'];
    tbody.innerHTML = filtered.map((o) => {
      const itemsSummary = (o.items || []).map((i) => `${i.qty}× ${escapeHTML(i.name)}`).join(', ');
      const typeDetail = o.orderType === 'Dine-In' && o.tableNumber
        ? `Dine-In (T-${escapeHTML(o.tableNumber)})`
        : escapeHTML(o.orderType);

      return `
        <tr>
          <td class="tabular"><strong>${escapeHTML(o.id)}</strong></td>
          <td class="muted-text tabular">${escapeHTML(formatDisplayDateTime(o.createdAt))}</td>
          <td>${escapeHTML(o.customerName)}</td>
          <td>
            <span class="status-pill ${o.source === 'Online' ? 'pill-neutral' : 'pill-success'}">${escapeHTML(o.source)}</span>
            <div class="muted-text" style="font-size: 0.78rem; margin-top: 2px;">${typeDetail}</div>
          </td>
          <td style="max-width: 240px; overflow-wrap: break-word;">${itemsSummary}</td>
          <td class="num"><strong>${formatPeso(o.total)}</strong></td>
          <td>
            <select class="status-select" data-action="change-order-status" data-id="${escapeHTML(o.id)}" aria-label="Status for ${escapeHTML(o.id)}">
              ${statuses.map((st) => `<option value="${st}" ${o.status === st ? 'selected' : ''}>${st}</option>`).join('')}
            </select>
          </td>
          <td class="actions-col">
            <div class="table-actions-inline">
              <button type="button" class="btn btn-subtle btn-sm" data-action="view-receipt" data-id="${escapeHTML(o.id)}">Receipt</button>
              ${isAdmin ? `<button type="button" class="btn btn-danger-outline btn-sm" data-action="delete-order" data-id="${escapeHTML(o.id)}">Delete</button>` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function updateOrderStatus(orderId, newStatus) {
    try {
      const updated = await apiFetch(`./api/orders/${encodeURIComponent(orderId)}`, {
        method: 'PATCH',
        body: { status: newStatus }
      });
      const idx = state.orders.findIndex((o) => String(o.id) === String(orderId));
      if (idx !== -1) state.orders[idx] = updated;
      showToast(`${orderId} updated to ${newStatus}`);
    } catch (err) {
      showToast(err.message || 'Could not update status.', 'error');
      renderOrdersTable();
    }
  }

  function openReceiptModal(order) {
    if (!order) return;
    const typeText = order.orderType === 'Dine-In' && order.tableNumber
      ? `Dine-In (Table ${escapeHTML(order.tableNumber)})`
      : escapeHTML(order.orderType);

    const itemsHtml = (order.items || []).map((i) => `
      <div class="receipt-line">
        <span>${i.qty}&times; ${escapeHTML(i.name)}</span>
        <span class="tabular">${formatPeso(i.price * i.qty)}</span>
      </div>
    `).join('');

    document.getElementById('receiptBody').innerHTML = `
      <div class="receipt-meta">
        <div class="receipt-meta-row"><span>Order ID</span><strong class="tabular">${escapeHTML(order.id)}</strong></div>
        <div class="receipt-meta-row"><span>Date</span><span class="tabular">${escapeHTML(formatDisplayDateTime(order.createdAt))}</span></div>
        <div class="receipt-meta-row"><span>Customer</span><span>${escapeHTML(order.customerName)}</span></div>
        <div class="receipt-meta-row"><span>Type</span><span>${typeText}</span></div>
        <div class="receipt-meta-row"><span>Channel</span><span>${escapeHTML(order.source)} (${escapeHTML(order.recordedBy || order.source)})</span></div>
        <div class="receipt-meta-row"><span>Status</span><span>${escapeHTML(order.status)}</span></div>
      </div>
      <div>${itemsHtml}</div>
      <div class="receipt-total">
        <span>TOTAL</span>
        <span class="tabular">${formatPeso(order.total)}</span>
      </div>
    `;
    openModal('receiptModal');
  }

  function triggerPrint(modeClass) {
    document.body.classList.remove('printing-receipt', 'printing-analytics');
    document.body.classList.add(modeClass);
    window.print();
    setTimeout(() => {
      document.body.classList.remove('printing-receipt', 'printing-analytics');
    }, 300);
  }

  /* ==========================================================================
   * 11. STAFF QUICK STOCK TOGGLE & ADMIN MENU CRUD
   * ======================================================================== */

  function renderStaffStockTable() {
    const tbody = document.getElementById('staffStockTableBody');
    if (!tbody) return;
    const term = (document.getElementById('stockSearchInput')?.value || '').trim().toLowerCase();
    const filtered = state.menu.filter((m) =>
      !term || m.name.toLowerCase().includes(term) || m.category.toLowerCase().includes(term)
    );

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">No dishes found.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map((m) => `
      <tr>
        <td><strong>${escapeHTML(m.name)}</strong></td>
        <td class="muted-text">${escapeHTML(m.category)}</td>
        <td class="num">${formatPeso(m.price)}</td>
        <td><span class="status-pill ${m.available ? 'pill-success' : 'pill-danger'}">${m.available ? 'Available' : 'Out of Stock'}</span></td>
        <td class="actions-col">
          <button type="button" class="btn btn-outline btn-sm" data-action="toggle-stock" data-id="${escapeHTML(m.id)}">
            ${m.available ? 'Mark Out of Stock' : 'Mark Available'}
          </button>
        </td>
      </tr>
    `).join('');
  }

  function renderAdminMenuTable() {
    const tbody = document.getElementById('adminMenuTableBody');
    if (!tbody) return;
    const term = (document.getElementById('adminMenuSearch')?.value || '').trim().toLowerCase();
    const filtered = state.menu.filter((m) =>
      !term || m.name.toLowerCase().includes(term) || m.category.toLowerCase().includes(term)
    );

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">No dishes match your search.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map((m) => {
      const profit = (Number(m.price) || 0) - (Number(m.cost) || 0);
      const margin = m.price > 0 ? ((profit / m.price) * 100).toFixed(1) : '0.0';
      const safeImg = sanitizeImageSrc(m.image);
      return `
        <tr>
          <td>
            <div class="admin-menu-dish-cell">
              <img src="${safeImg}" alt="${escapeHTML(m.name)}" class="admin-menu-thumb" loading="lazy" data-fallback-img="true">
              <div class="admin-menu-dish-meta">
                <strong>${escapeHTML(m.name)}</strong>
                <div class="muted-text admin-menu-dish-path">${escapeHTML(safeImg)}</div>
              </div>
            </div>
          </td>
          <td class="muted-text">${escapeHTML(m.category)}</td>
          <td class="num">${formatPeso(m.price)}</td>
          <td class="num">${formatPeso(m.cost)}</td>
          <td class="num" style="color: var(--sage);">${margin}%</td>
          <td><span class="status-pill ${m.available ? 'pill-success' : 'pill-danger'}">${m.available ? 'Available' : 'Out of Stock'}</span></td>
          <td class="actions-col">
            <div class="table-actions-inline">
              <button type="button" class="btn btn-subtle btn-sm" data-action="toggle-stock" data-id="${escapeHTML(m.id)}">${m.available ? 'Pause' : 'Restore'}</button>
              <button type="button" class="btn btn-outline btn-sm" data-action="edit-dish" data-id="${escapeHTML(m.id)}">Edit</button>
              <button type="button" class="btn btn-danger-outline btn-sm" data-action="delete-dish" data-id="${escapeHTML(m.id)}">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function toggleDishStock(itemId) {
    try {
      const updated = await apiFetch(`./api/menu/${encodeURIComponent(itemId)}/toggle`, { method: 'PATCH' });
      const idx = state.menu.findIndex((m) => String(m.id) === String(itemId));
      if (idx !== -1) state.menu[idx] = updated;
      renderStaffStockTable();
      renderAdminMenuTable();
      renderPosMenu();
      renderPublicMenu();
      showToast(`${updated.name}: ${updated.available ? 'Available' : 'Out of Stock'}`);
    } catch (err) {
      showToast(err.message || 'Failed to update stock.', 'error');
    }
  }

  function updateDishMarginPreview() {
    const price = Number(document.getElementById('dishFormPrice').value) || 0;
    const cost = Number(document.getElementById('dishFormCost').value) || 0;
    const profit = price - cost;
    const pct = price > 0 ? (profit / price) * 100 : 0;
    const el = document.getElementById('dishMarginPreview');
    el.textContent = `Estimated Profit: ${formatPeso(profit)} (${pct.toFixed(1)}% margin)`;
    el.style.color = profit >= 0 ? 'var(--sage)' : 'var(--crimson)';
  }

  const MAX_RAW_PHOTO_BYTES = 8 * 1024 * 1024; // 8MB client pre-check
  const MAX_DECODED_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB server decoded cap
  const ALLOWED_PHOTO_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
  const ALLOWED_PHOTO_EXT_RE = /\.(jpe?g|png|webp|gif)$/i;

  function resetDishPhotoDraft(imagePath = FALLBACK_IMG) {
    const safePath = sanitizeImageSrc(imagePath);
    state.dishPhotoDraft = {
      dataUrl: null,
      filename: '',
      removed: false,
      currentPath: safePath
    };
    const fileInput = document.getElementById('dishPhotoFileInput');
    if (fileInput) fileInput.value = '';
    const dropzone = document.getElementById('dishPhotoDropzone');
    if (dropzone) dropzone.classList.remove('is-dragover');
    updateDishPhotoPreviewUI();
  }

  function updateDishPhotoPreviewUI() {
    const previewImg = document.getElementById('dishFormPreviewImg');
    const hiddenPath = document.getElementById('dishFormImage');
    const pathText = document.getElementById('dishFormImagePathText');
    const hintEl = document.getElementById('dishPhotoStatusHint');
    const removeBtn = document.getElementById('dishPhotoRemoveBtn');
    const draft = state.dishPhotoDraft;
    if (!previewImg || !hiddenPath || !pathText || !hintEl || !removeBtn) return;

    previewImg.dataset.fallbackImg = 'true';
    hintEl.classList.remove('is-pending', 'is-removing');

    if (draft.dataUrl) {
      previewImg.src = draft.dataUrl;
      hiddenPath.value = draft.currentPath;
      pathText.textContent = `Ready to upload: ${draft.filename}`;
      hintEl.textContent = 'New optimized photo selected. Click Save Dish to upload and apply.';
      hintEl.classList.add('is-pending');
      removeBtn.disabled = false;
    } else if (draft.removed) {
      previewImg.src = FALLBACK_IMG;
      hiddenPath.value = FALLBACK_IMG;
      pathText.textContent = FALLBACK_IMG;
      hintEl.textContent = 'Photo marked for removal. Previous unused image will be cleaned up on Save Dish.';
      hintEl.classList.add('is-removing');
      removeBtn.disabled = true;
    } else {
      const safePath = sanitizeImageSrc(draft.currentPath);
      previewImg.src = safePath;
      hiddenPath.value = safePath;
      pathText.textContent = safePath;
      hintEl.textContent = 'Drag & drop or choose JPG, PNG, WebP, or GIF (max 8MB). Photos auto-optimize on save.';
      removeBtn.disabled = safePath === FALLBACK_IMG;
    }
  }

  function estimateDataUrlBytes(dataUrl) {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return 0;
    const b64 = dataUrl.slice(commaIdx + 1);
    return Math.floor((b64.length * 3) / 4);
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read the selected image file.'));
      reader.readAsDataURL(file);
    });
  }

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Selected file could not be decoded as an image.'));
      img.src = src;
    });
  }

  async function compressDishPhoto(file) {
    const lowerMime = String(file.type || '').toLowerCase();
    const isGif = lowerMime === 'image/gif' || /\.gif$/i.test(file.name);

    // Keep GIFs intact (preserves animation if animated) while enforcing 5MB server cap
    if (isGif) {
      const rawDataUrl = await readFileAsDataUrl(file);
      if (estimateDataUrlBytes(rawDataUrl) > MAX_DECODED_UPLOAD_BYTES) {
        throw new Error('GIF exceeds the 5MB limit. Please choose a smaller GIF or JPG/PNG photo.');
      }
      return { dataUrl: rawDataUrl, filename: file.name || 'dish.gif' };
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await loadImageElement(objectUrl);
      const maxWidth = 1200;
      const origW = img.naturalWidth || img.width;
      const origH = img.naturalHeight || img.height;
      if (!origW || !origH) {
        throw new Error('Could not determine image dimensions.');
      }

      const scale = origW > maxWidth ? maxWidth / origW : 1;
      const targetW = Math.max(1, Math.round(origW * scale));
      const targetH = Math.max(1, Math.round(origH * scale));

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Browser canvas is unavailable for image optimization.');
      }

      const isPng = lowerMime === 'image/png' || /\.png$/i.test(file.name);
      const isWebp = lowerMime === 'image/webp' || /\.webp$/i.test(file.name);

      // Prefer WebP when supported for sharp lightweight photos (including transparency); fall back to JPEG
      let outputMime = isPng || isWebp ? 'image/webp' : 'image/jpeg';
      if (outputMime === 'image/jpeg') {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, targetW, targetH);
      }
      ctx.drawImage(img, 0, 0, targetW, targetH);

      let dataUrl = canvas.toDataURL(outputMime, 0.85);

      // Safari / older browsers may fall back to PNG if WebP encoding is unsupported
      if (outputMime === 'image/webp' && !dataUrl.startsWith('data:image/webp')) {
        outputMime = isPng ? 'image/png' : 'image/jpeg';
        if (outputMime === 'image/jpeg') {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, targetW, targetH);
          ctx.drawImage(img, 0, 0, targetW, targetH);
        }
        dataUrl = canvas.toDataURL(outputMime, 0.85);
      }

      // Secondary quality pass if output is still above 5MB
      if (estimateDataUrlBytes(dataUrl) > MAX_DECODED_UPLOAD_BYTES) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, targetW, targetH);
        ctx.drawImage(img, 0, 0, targetW, targetH);
        dataUrl = canvas.toDataURL('image/jpeg', 0.72);
        outputMime = 'image/jpeg';
      }

      if (estimateDataUrlBytes(dataUrl) > MAX_DECODED_UPLOAD_BYTES) {
        throw new Error('Optimized photo is still over 5MB. Please pick a smaller image.');
      }

      const ext = outputMime === 'image/webp' ? 'webp' : outputMime === 'image/png' ? 'png' : 'jpg';
      const stem = (file.name || 'dish').replace(/\.[^.]+$/, '') || 'dish';
      return { dataUrl, filename: `${stem}.${ext}` };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function handleDishPhotoSelection(file) {
    if (!file) return;
    const mimeOk = file.type ? ALLOWED_PHOTO_MIMES.has(file.type.toLowerCase()) : false;
    const extOk = ALLOWED_PHOTO_EXT_RE.test(file.name || '');

    if (!mimeOk && !extOk) {
      showToast('Unsupported file type. Please choose a JPG, PNG, WebP, or GIF image.', 'error');
      return;
    }
    if (file.size > MAX_RAW_PHOTO_BYTES) {
      showToast('Photo exceeds 8MB. Please choose a smaller image file.', 'error');
      return;
    }

    const uploadBtn = document.getElementById('dishPhotoUploadBtn');
    const saveBtn = document.getElementById('saveDishBtn');
    if (uploadBtn) {
      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Optimizing...';
    }
    if (saveBtn) saveBtn.disabled = true;

    try {
      const prepared = await compressDishPhoto(file);
      state.dishPhotoDraft.dataUrl = prepared.dataUrl;
      state.dishPhotoDraft.filename = prepared.filename;
      state.dishPhotoDraft.removed = false;
      updateDishPhotoPreviewUI();
      showToast('Photo ready. Click Save Dish to apply.');
    } catch (err) {
      showToast(err.message || 'Could not process selected photo.', 'error');
    } finally {
      if (uploadBtn) {
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload / Change Photo';
      }
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function handleDishPhotoRemove() {
    state.dishPhotoDraft.dataUrl = null;
    state.dishPhotoDraft.filename = '';
    state.dishPhotoDraft.removed = true;
    const fileInput = document.getElementById('dishPhotoFileInput');
    if (fileInput) fileInput.value = '';
    updateDishPhotoPreviewUI();
  }

  function openDishFormModal(dish = null) {
    document.getElementById('dishFormModalTitle').textContent = dish ? 'Edit Dish' : 'Add New Dish';
    document.getElementById('dishFormId').value = dish ? dish.id : '';
    document.getElementById('dishFormName').value = dish ? dish.name : '';
    document.getElementById('dishFormDesc').value = dish ? dish.description : '';
    document.getElementById('dishFormCategory').value = dish ? dish.category : 'Mains';
    document.getElementById('dishFormAvailable').value = dish ? String(dish.available) : 'true';
    document.getElementById('dishFormPrice').value = dish ? String(dish.price) : '';
    document.getElementById('dishFormCost').value = dish ? String(dish.cost) : '';
    resetDishPhotoDraft(dish ? dish.image : FALLBACK_IMG);
    updateDishMarginPreview();
    openModal('dishFormModal');
  }

  async function handleDishCrudSubmit(e) {
    e.preventDefault();
    const btn = document.getElementById('saveDishBtn');
    const uploadBtn = document.getElementById('dishPhotoUploadBtn');
    const removeBtn = document.getElementById('dishPhotoRemoveBtn');
    const id = document.getElementById('dishFormId').value.trim();

    const payload = {
      name: document.getElementById('dishFormName').value.trim(),
      description: document.getElementById('dishFormDesc').value.trim(),
      category: document.getElementById('dishFormCategory').value,
      available: document.getElementById('dishFormAvailable').value === 'true',
      price: Number(document.getElementById('dishFormPrice').value),
      cost: Number(document.getElementById('dishFormCost').value),
      image: state.dishPhotoDraft.removed ? FALLBACK_IMG : state.dishPhotoDraft.currentPath
    };

    btn.disabled = true;
    if (uploadBtn) uploadBtn.disabled = true;
    if (removeBtn) removeBtn.disabled = true;
    btn.textContent = state.dishPhotoDraft.dataUrl ? 'Uploading photo...' : 'Saving...';

    try {
      // Upload selected photo ONLY on Save Dish so Cancel never leaves orphan files
      if (state.dishPhotoDraft.dataUrl) {
        const preferredName = payload.name || state.dishPhotoDraft.filename || 'dish';
        const uploadRes = await apiFetch('./api/menu/upload-image', {
          method: 'POST',
          body: {
            dataUrl: state.dishPhotoDraft.dataUrl,
            filename: preferredName
          }
        });
        payload.image = uploadRes.image;
      }

      btn.textContent = 'Saving...';
      if (id) {
        await apiFetch(`./api/menu/${encodeURIComponent(id)}`, { method: 'PUT', body: payload });
        showToast('Dish updated.');
      } else {
        await apiFetch('./api/menu', { method: 'POST', body: payload });
        showToast('New dish added to menu.');
      }
      closeAllModals();
      await loadMenu();
    } catch (err) {
      showToast(err.message || 'Could not save dish.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Dish';
      if (uploadBtn) uploadBtn.disabled = false;
      updateDishPhotoPreviewUI();
    }
  }

  /* ==========================================================================
   * 12. ADMIN ACCOUNT MANAGEMENT CRUD
   * ======================================================================== */

  async function loadAdminUsers() {
    const users = await apiFetch('./api/users');
    state.users = Array.isArray(users) ? users : [];
    renderAccountsTable();
  }

  function renderAccountsTable() {
    const tbody = document.getElementById('accountsTableBody');
    if (!tbody) return;
    if (state.users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="empty-cell">No accounts found.</td></tr>`;
      return;
    }

    tbody.innerHTML = state.users.map((u) => {
      const isSelf = state.user && String(u.id) === String(state.user.id);
      return `
        <tr>
          <td>
            <strong>${escapeHTML(u.username)}</strong>
            ${isSelf ? ' <span class="muted-text">(You)</span>' : ''}
          </td>
          <td><span class="status-pill ${u.role === 'admin' ? 'pill-success' : 'pill-neutral'}">${u.role === 'admin' ? 'Admin' : 'Staff'}</span></td>
          <td class="actions-col">
            <div class="table-actions-inline">
              <button type="button" class="btn btn-outline btn-sm" data-action="edit-account" data-id="${escapeHTML(u.id)}">Edit</button>
              <button type="button" class="btn btn-danger-outline btn-sm" data-action="delete-account" data-id="${escapeHTML(u.id)}" ${isSelf ? 'disabled' : ''}>Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function handleAddAccountSubmit(e) {
    e.preventDefault();
    const btn = document.getElementById('createAccountBtn');
    const username = document.getElementById('newAccUsername').value.trim();
    const password = document.getElementById('newAccPassword').value;
    const role = document.getElementById('newAccRole').value;

    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
      await apiFetch('./api/users', { method: 'POST', body: { username, password, role } });
      document.getElementById('addAccountForm').reset();
      await loadAdminUsers();
      showToast(`Account "${username}" created.`);
    } catch (err) {
      showToast(err.message || 'Could not create account.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create Account';
    }
  }

  function openEditAccountModal(userId) {
    const u = state.users.find((x) => String(x.id) === String(userId));
    if (!u) return;
    document.getElementById('editAccId').value = u.id;
    document.getElementById('editAccUsername').value = u.username;
    document.getElementById('editAccRole').value = u.role;
    document.getElementById('editAccPassword').value = '';
    openModal('editAccountModal');
  }

  async function handleEditAccountSubmit(e) {
    e.preventDefault();
    const btn = document.getElementById('saveEditAccBtn');
    const id = document.getElementById('editAccId').value;
    const username = document.getElementById('editAccUsername').value.trim();
    const role = document.getElementById('editAccRole').value;
    const password = document.getElementById('editAccPassword').value;

    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      const updated = await apiFetch(`./api/users/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: { username, role, password }
      });

      // Keep active session header synced if Admin edited their own account
      if (state.user && String(state.user.id) === String(updated.id)) {
        state.user = updated;
        updatePortalHeader();
        updatePublicNavAuthButton();
      }
      closeAllModals();
      await loadAdminUsers();
      showToast(`Updated account "${updated.username}".`);
    } catch (err) {
      showToast(err.message || 'Could not update account.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  }

  /* ==========================================================================
   * 13. GLOBAL EVENT DELEGATION & LIVE RESIZE HANDLER (Bound Once)
   * ======================================================================== */

  function bindEventsOnce() {
    // Resilient image fallback delegation via capture-phase error event
    document.addEventListener('error', (e) => {
      const target = e.target;
      if (target && target.tagName === 'IMG' && target.dataset.fallbackImg === 'true') {
        target.dataset.fallbackImg = 'done';
        target.src = FALLBACK_IMG;
      }
    }, true);

    // Dismiss backend warning banner
    document.getElementById('dismissBannerBtn')?.addEventListener('click', () => {
      document.getElementById('backendBanner').classList.add('hidden');
    });

    // Public Navbar & Cart Drawer Controls
    document.getElementById('openCartBtn')?.addEventListener('click', openCartDrawer);
    document.getElementById('mobileCartBarBtn')?.addEventListener('click', openCartDrawer);
    document.getElementById('closeCartDrawerBtn')?.addEventListener('click', closeCartDrawer);
    document.getElementById('cartDrawerBackdrop')?.addEventListener('click', closeCartDrawer);

    document.getElementById('openPortalOrLoginBtn')?.addEventListener('click', () => {
      if (state.user) enterPortal();
      else {
        document.getElementById('loginErrorMsg').classList.add('hidden');
        openModal('loginModal');
      }
    });

    // Public Menu Search
    document.getElementById('publicMenuSearch')?.addEventListener('input', (e) => {
      state.publicSearch = e.target.value;
      renderPublicMenu();
    });

    // Dish Detail Modal Add Button
    document.getElementById('dishModalAddBtn')?.addEventListener('click', () => {
      if (!state.activeDetailDishId) return;
      addToPublicCart(state.activeDetailDishId, false);
      closeAllModals();
    });

    // Public Checkout & Order Confirm Track CTA
    document.getElementById('publicCheckoutForm')?.addEventListener('submit', handlePublicCheckout);
    document.getElementById('confirmTrackNowBtn')?.addEventListener('click', () => {
      const id = state.lastPlacedOrderId;
      closeAllModals();
      if (id) {
        document.getElementById('trackSection')?.scrollIntoView({ behavior: 'smooth' });
        trackOrderById(id);
      }
    });

    // Order Tracking Form
    document.getElementById('trackOrderForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      trackOrderById(document.getElementById('trackOrderIdInput').value);
    });

    // Auth & Portal Header Controls
    document.getElementById('loginForm')?.addEventListener('submit', handleLoginSubmit);
    document.getElementById('viewPublicSiteBtn')?.addEventListener('click', switchToPublicView);
    document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);

    // Analytics Controls & Exports
    document.getElementById('refreshAnalyticsBtn')?.addEventListener('click', () => {
      loadAdminAnalytics().then(() => showToast('Analytics refreshed.')).catch(() => {});
    });
    document.getElementById('dailyTargetForm')?.addEventListener('submit', handleSaveDailyTarget);
    document.getElementById('exportTxCsvBtn')?.addEventListener('click', exportTransactionsCsv);
    document.getElementById('exportMenuCsvBtn')?.addEventListener('click', exportMenuEngagementCsv);
    document.getElementById('printAnalyticsBtn')?.addEventListener('click', () => triggerPrint('printing-analytics'));

    // Walk-In POS Controls
    document.getElementById('posSearchInput')?.addEventListener('input', (e) => {
      state.posSearch = e.target.value;
      renderPosMenu();
    });
    document.getElementById('clearPosCartBtn')?.addEventListener('click', () => {
      state.posCart = [];
      renderPosCart();
    });
    document.getElementById('posCheckoutForm')?.addEventListener('submit', handlePosCheckout);

    // Order Queue Controls
    document.getElementById('refreshOrdersBtn')?.addEventListener('click', () => {
      loadPortalOrders().then(() => showToast('Order queue refreshed.')).catch(() => {});
    });
    document.getElementById('orderSearchInput')?.addEventListener('input', (e) => {
      state.orderSearch = e.target.value;
      renderOrdersTable();
    });
    document.getElementById('orderStatusFilter')?.addEventListener('change', (e) => {
      state.orderStatusFilter = e.target.value;
      renderOrdersTable();
    });
    document.getElementById('orderSourceFilter')?.addEventListener('change', (e) => {
      state.orderSourceFilter = e.target.value;
      renderOrdersTable();
    });

    // Stock & Admin Menu Controls
    document.getElementById('stockSearchInput')?.addEventListener('input', renderStaffStockTable);
    document.getElementById('adminMenuSearch')?.addEventListener('input', renderAdminMenuTable);
    document.getElementById('openAddDishBtn')?.addEventListener('click', () => openDishFormModal(null));
    document.getElementById('dishFormPrice')?.addEventListener('input', updateDishMarginPreview);
    document.getElementById('dishFormCost')?.addEventListener('input', updateDishMarginPreview);
    document.getElementById('dishCrudForm')?.addEventListener('submit', handleDishCrudSubmit);

    // Dish Photo Uploader (Click, File Input, Remove, and Drag-and-Drop)
    const dishPhotoFileInput = document.getElementById('dishPhotoFileInput');
    const dishPhotoDropzone = document.getElementById('dishPhotoDropzone');
    document.getElementById('dishPhotoUploadBtn')?.addEventListener('click', () => {
      dishPhotoFileInput?.click();
    });
    dishPhotoFileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) handleDishPhotoSelection(file);
      e.target.value = '';
    });
    document.getElementById('dishPhotoRemoveBtn')?.addEventListener('click', handleDishPhotoRemove);
    if (dishPhotoDropzone) {
      ['dragenter', 'dragover'].forEach((evtName) => {
        dishPhotoDropzone.addEventListener(evtName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dishPhotoDropzone.classList.add('is-dragover');
        });
      });
      ['dragleave', 'drop'].forEach((evtName) => {
        dishPhotoDropzone.addEventListener(evtName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dishPhotoDropzone.classList.remove('is-dragover');
        });
      });
      dishPhotoDropzone.addEventListener('drop', (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (file) handleDishPhotoSelection(file);
      });
    }

    // Account Management Controls
    document.getElementById('addAccountForm')?.addEventListener('submit', handleAddAccountSubmit);
    document.getElementById('editAccountForm')?.addEventListener('submit', handleEditAccountSubmit);

    // Receipt Print & Generic Confirmation Proceed
    document.getElementById('printReceiptBtn')?.addEventListener('click', () => triggerPrint('printing-receipt'));
    document.getElementById('confirmActionProceedBtn')?.addEventListener('click', async () => {
      if (typeof state.pendingConfirmAction !== 'function') return;
      const fn = state.pendingConfirmAction;
      const btn = document.getElementById('confirmActionProceedBtn');
      btn.disabled = true;
      try {
        await fn();
        closeAllModals();
      } catch (err) {
        showToast(err.message || 'Action failed.', 'error');
      } finally {
        btn.disabled = false;
      }
    });

    // Global Click Delegation via data-action attributes
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) {
        // Backdrop click closes modal
        if (e.target.classList.contains('modal-backdrop')) {
          closeAllModals();
        }
        return;
      }

      const action = target.dataset.action;
      const id = target.dataset.id;

      if (action === 'close-modal') {
        closeAllModals();
      } else if (action === 'scroll-top') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (action === 'public-category') {
        state.publicCategory = target.dataset.category || 'All';
        document.querySelectorAll('#publicCategoryBar .pill-tab').forEach((b) => {
          const active = b.dataset.category === state.publicCategory;
          b.classList.toggle('active', active);
          b.setAttribute('aria-selected', String(active));
        });
        trackEvent({ type: 'category_click', category: state.publicCategory });
        renderPublicMenu();
      } else if (action === 'open-dish') {
        openDishDetail(id);
      } else if (action === 'add-public-cart') {
        addToPublicCart(id, true);
      } else if (action === 'pub-qty') {
        updatePublicCartQty(id, Number(target.dataset.delta));
      } else if (action === 'public-order-type') {
        state.publicOrderType = target.dataset.value || 'Dine-In';
        document.querySelectorAll('[data-action="public-order-type"]').forEach((b) => {
          b.classList.toggle('active', b.dataset.value === state.publicOrderType);
        });
        document.getElementById('publicTableGroup').classList.toggle('hidden', state.publicOrderType !== 'Dine-In');
      } else if (action === 'track-chip') {
        trackOrderById(id);
      } else if (action === 'rate-order') {
        submitOrderRating(id, target.dataset.rating);
      } else if (action === 'portal-tab') {
        switchPortalTab(target.dataset.tab);
      } else if (action === 'analytics-range') {
        state.analyticsRange = target.dataset.range || 'all';
        document.querySelectorAll('[data-action="analytics-range"]').forEach((b) => {
          b.classList.toggle('active', b.dataset.range === state.analyticsRange);
        });
        renderAdminAnalytics();
      } else if (action === 'pos-category') {
        state.posCategory = target.dataset.category || 'All';
        document.querySelectorAll('#posCategoryBar .pill-tab').forEach((b) => {
          b.classList.toggle('active', b.dataset.category === state.posCategory);
        });
        renderPosMenu();
      } else if (action === 'add-pos-cart') {
        addToPosCart(id);
      } else if (action === 'pos-qty') {
        updatePosCartQty(id, Number(target.dataset.delta));
      } else if (action === 'pos-order-type') {
        state.posOrderType = target.dataset.value || 'Dine-In';
        document.querySelectorAll('[data-action="pos-order-type"]').forEach((b) => {
          b.classList.toggle('active', b.dataset.value === state.posOrderType);
        });
        document.getElementById('posTableGroup').classList.toggle('hidden', state.posOrderType !== 'Dine-In');
      } else if (action === 'view-receipt') {
        const order = state.orders.find((o) => String(o.id) === String(id));
        if (order) openReceiptModal(order);
      } else if (action === 'delete-order') {
        openConfirmModal(
          'Delete Order',
          `Permanently remove order ${id} from records? This cannot be undone.`,
          async () => {
            await apiFetch(`./api/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
            state.orders = state.orders.filter((o) => String(o.id) !== String(id));
            renderOrdersTable();
            showToast(`Order ${id} deleted.`);
          }
        );
      } else if (action === 'toggle-stock') {
        toggleDishStock(id);
      } else if (action === 'edit-dish') {
        const dish = state.menu.find((m) => String(m.id) === String(id));
        if (dish) openDishFormModal(dish);
      } else if (action === 'delete-dish') {
        const dish = state.menu.find((m) => String(m.id) === String(id));
        openConfirmModal(
          'Delete Menu Dish',
          `Remove "${dish ? dish.name : 'this dish'}" from the Kusina Moderna menu?`,
          async () => {
            await apiFetch(`./api/menu/${encodeURIComponent(id)}`, { method: 'DELETE' });
            await loadMenu();
            showToast('Dish removed from menu.');
          }
        );
      } else if (action === 'edit-account') {
        openEditAccountModal(id);
      } else if (action === 'delete-account') {
        const acc = state.users.find((u) => String(u.id) === String(id));
        openConfirmModal(
          'Delete Account',
          `Delete account "${acc ? acc.username : 'this user'}"? They will lose portal access immediately.`,
          async () => {
            await apiFetch(`./api/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
            await loadAdminUsers();
            showToast('Account deleted.');
          }
        );
      }
    });

    // Global Change Delegation for live Order Queue status selects
    document.addEventListener('change', (e) => {
      const target = e.target;
      if (target && target.dataset.action === 'change-order-status') {
        updateOrderStatus(target.dataset.id, target.value);
      }
    });

    // Escape key closes modals & drawers cleanly and restores scroll
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllModals();
        closeCartDrawer();
      }
    });

    // Debounced live resize & orientationchange: close mobile drawer on desktop & resize active charts
    let resizeTimer = null;
    const handleViewportResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (window.innerWidth >= 1024) {
          closeCartDrawer();
        }
        const nowNarrow = window.innerWidth < 640;
        if (
          state.activeView === 'portal' &&
          state.activePortalTab === 'analytics' &&
          state.analyticsData &&
          state.lastChartNarrowMode !== null &&
          state.lastChartNarrowMode !== nowNarrow
        ) {
          renderAdminAnalytics();
        } else {
          resizeAllCharts();
        }
      }, 140);
    };
    window.addEventListener('resize', handleViewportResize);
    window.addEventListener('orientationchange', handleViewportResize);
  }

  /* ==========================================================================
   * 14. INITIALIZATION
   * ======================================================================== */

  document.addEventListener('DOMContentLoaded', async () => {
    bindEventsOnce();
    renderPublicCart();
    renderRecentOrderChips();
    updatePublicNavAuthButton();

    try {
      await loadMenu();
      logInitialPageView();
    } catch {
      document.getElementById('publicMenuGrid').innerHTML =
        `<div class="card empty-cell" style="grid-column: 1 / -1;">Unable to load menu. Start the Node.js server with <code>npm start</code>.</div>`;
    }
  });
})();
