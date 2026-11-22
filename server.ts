/**
 * Kusina Moderna — Express Backend Server BREDWUZHEREBLEHHHHHH
 * IT 314 Web Systems & Technologies (BSIT 3107, Group 11 Business Analytics Track)
 *
 * Uses Express + built-in Node.js modules (fs, path, crypto, url) with local JSON storage.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

type Role = 'staff' | 'admin';
type OrderStatus = 'Pending' | 'Preparing' | 'Ready' | 'Completed' | 'Cancelled';

interface UserRecord {
  id: string;
  username: string;
  password: string;
  role: Role;
}

interface SanitizedUser {
  id: string;
  username: string;
  role: Role;
}

interface MenuItem {
  id: string;
  name: string;
  description: string;
  category: string;
  price: number;
  cost: number;
  image: string;
  available: boolean;
}

interface OrderItem {
  itemId: string;
  name: string;
  category: string;
  qty: number;
  price: number;
  cost: number;
}

interface OrderRecord {
  id: string;
  customerName: string;
  orderType: 'Dine-In' | 'Take-Out';
  tableNumber: string;
  source: 'Online' | 'Walk-In POS';
  recordedBy: string;
  items: OrderItem[];
  total: number;
  totalCost: number;
  browseDurationSec: number | null;
  status: OrderStatus;
  rating: number | null;
  createdAt: string;
}

interface DatabaseSchema {
  settings: {
    dailyTarget: number;
  };
  users: UserRecord[];
  menu: MenuItem[];
  orders: OrderRecord[];
  tracking: {
    pageViews: Array<{ timestamp: string }>;
    menuClicks: Array<{
      itemId: string;
      itemName: string;
      category: string;
      timestamp: string;
    }>;
  };
}

interface AuthenticatedRequest extends Request {
  currentUser?: UserRecord;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DB_DIR = path.resolve(__dirname, 'data');
const DB_PATH = path.resolve(DB_DIR, 'database.json');
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const IMAGES_DIR = path.resolve(PUBLIC_DIR, 'images');
const MAX_TRACKING_ENTRIES = 5000;
const MAX_IMAGE_DECODED_BYTES = 5 * 1024 * 1024; // 5MB decoded file cap

// Ensure dish images directory exists on startup (local, preview, and Render)
fs.mkdirSync(IMAGES_DIR, { recursive: true });

const VALID_CATEGORIES = ['Mains', 'Soups & Bowls', 'Snacks & Desserts', 'Drinks'];
const VALID_STATUSES: OrderStatus[] = ['Pending', 'Preparing', 'Ready', 'Completed', 'Cancelled'];
const VALID_ROLES: Role[] = ['staff', 'admin'];
const ALLOWED_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'];

// Server-side HMAC signing secret for Bearer tokens (uses env or ephemeral random fallback)
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Parse JSON request bodies safely (10MB supports base64 dish photo uploads)
app.use(express.json({ limit: '10mb' }));

// Mount /images BEFORE general static assets so newly uploaded dish photos load immediately
app.use('/images', express.static(IMAGES_DIR));

// Serve static frontend files from /public
app.use(express.static(PUBLIC_DIR));

/* 
 * PASSWORD HASHING & SIGNED SESSION TOKEN HELPERS
 *  */

function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(plain: string, stored: string): { valid: boolean; needsUpgrade: boolean } {
  if (!stored || typeof stored !== 'string') {
    return { valid: false, needsUpgrade: false };
  }
  if (stored.startsWith('scrypt:')) {
    const parts = stored.split(':');
    if (parts.length !== 3) return { valid: false, needsUpgrade: false };
    const [, salt, storedHex] = parts;
    try {
      const derivedBuf = crypto.scryptSync(plain, salt, 64);
      const storedBuf = Buffer.from(storedHex, 'hex');
      if (derivedBuf.length !== storedBuf.length) {
        return { valid: false, needsUpgrade: false };
      }
      return { valid: crypto.timingSafeEqual(derivedBuf, storedBuf), needsUpgrade: false };
    } catch {
      return { valid: false, needsUpgrade: false };
    }
  }
  // Support migrating manually edited plaintext entries seamlessly on login
  const a = crypto.createHash('sha256').update(plain).digest();
  const b = crypto.createHash('sha256').update(stored).digest();
  const match = crypto.timingSafeEqual(a, b);
  return { valid: match, needsUpgrade: match };
}

function signAuthToken(userId: string): string {
  const payloadObj = {
    uid: String(userId),
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS
  };
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sigB64 = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sigB64}`;
}

function verifyAuthToken(token: string): { uid: string } | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  try {
    const expectedSig = crypto
      .createHmac('sha256', SESSION_SECRET)
      .update(payloadB64)
      .digest();
    const providedSig = Buffer.from(sigB64, 'base64url');
    if (expectedSig.length !== providedSig.length) return null;
    if (!crypto.timingSafeEqual(expectedSig, providedSig)) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload || typeof payload.uid !== 'string' || typeof payload.exp !== 'number') {
      return null;
    }
    if (Date.now() > payload.exp) return null;
    return { uid: payload.uid };
  } catch {
    return null;
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/* 
 * DATABASE HELPERS (Crash-Resilient Local JSON Storage)
 *  */

function getDefaultDB(): DatabaseSchema {
  return {
    settings: { dailyTarget: 6000 },
    users: [],
    menu: [],
    orders: [],
    tracking: {
      pageViews: [],
      menuClicks: []
    }
  };
}

function ensureDBStructure(db: unknown): DatabaseSchema {
  const safe = (db && typeof db === 'object' ? db : getDefaultDB()) as Partial<DatabaseSchema>;
  const settings = safe.settings && typeof safe.settings === 'object' ? safe.settings : { dailyTarget: 6000 };
  const dailyTarget =
    typeof settings.dailyTarget === 'number' && Number.isFinite(settings.dailyTarget) && settings.dailyTarget > 0
      ? settings.dailyTarget
      : 6000;

  const tracking = safe.tracking && typeof safe.tracking === 'object'
    ? safe.tracking
    : { pageViews: [], menuClicks: [] };

  return {
    settings: { dailyTarget },
    users: Array.isArray(safe.users) ? safe.users : [],
    menu: Array.isArray(safe.menu) ? safe.menu : [],
    orders: Array.isArray(safe.orders) ? safe.orders : [],
    tracking: {
      pageViews: Array.isArray(tracking.pageViews) ? tracking.pageViews : [],
      menuClicks: Array.isArray(tracking.menuClicks) ? tracking.menuClicks : []
    }
  };
}

function readDB(): DatabaseSchema {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    if (!DB_PATH.startsWith(DB_DIR + path.sep)) {
      throw new Error('Invalid database path');
    }
    if (!fs.existsSync(DB_PATH)) {
      const fallback = getDefaultDB();
      fs.writeFileSync(DB_PATH, JSON.stringify(fallback, null, 2), 'utf8');
      return fallback;
    }
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return ensureDBStructure(JSON.parse(raw));
  } catch (err) {
    console.error('Error reading database.json:', err instanceof Error ? err.message : err);
    return getDefaultDB();
  }
}

function writeDB(data: DatabaseSchema): boolean {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    if (!DB_PATH.startsWith(DB_DIR + path.sep)) {
      throw new Error('Invalid database path');
    }
    const normalized = ensureDBStructure(data);
    fs.writeFileSync(DB_PATH, JSON.stringify(normalized, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing database.json:', err instanceof Error ? err.message : err);
    return false;
  }
}

// Strip password before returning any user object
function sanitizeUser(user: UserRecord): SanitizedUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role
  };
}

// Normalize and strictly confine image filename to ./images/<lowercase-file>
function normalizeImagePath(input: unknown): string {
  const raw = String(input || '').trim();
  if (!raw) return './images/default-food.svg';
  const stripped = raw.replace(/^(\.\/)?images\//i, '');
  const baseName = path.basename(stripped).replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase();
  if (!baseName) return './images/default-food.svg';
  const ext = path.extname(baseName);
  if (!ALLOWED_IMAGE_EXTS.includes(ext)) {
    return './images/default-food.svg';
  }
  const resolved = path.resolve(IMAGES_DIR, baseName);
  if (!resolved.startsWith(IMAGES_DIR + path.sep)) {
    return './images/default-food.svg';
  }
  return `./images/${baseName}`;
}

// Validate magic bytes so uploaded payloads genuinely match declared image format
function verifyImageMagicBytes(buf: Buffer, ext: string): boolean {
  if (ext === 'jpg') {
    return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (ext === 'png') {
    return (
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    );
  }
  if (ext === 'gif') {
    if (buf.length < 6) return false;
    const header = buf.subarray(0, 6).toString('ascii');
    return header === 'GIF87a' || header === 'GIF89a';
  }
  if (ext === 'webp') {
    return (
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

// Safely remove an unused dish image from public/images/ with strict path and reference guards
function safeDeleteImageIfUnused(imagePath: string | undefined | null, db: DatabaseSchema): boolean {
  const raw = String(imagePath || '').trim();
  if (!raw || /^(https?:|data:)/i.test(raw)) {
    return false;
  }

  const stripped = raw.replace(/^(\.\/)?images\//i, '');
  const baseName = path.basename(stripped).toLowerCase();
  if (!baseName || baseName === 'default-food.svg') {
    return false;
  }

  // Only delete if zero remaining menu dishes reference this same filename
  const stillReferenced = db.menu.some((m) => {
    const otherRaw = String(m.image || '').trim();
    const otherBase = path.basename(otherRaw.replace(/^(\.\/)?images\//i, '')).toLowerCase();
    return otherBase === baseName;
  });
  if (stillReferenced) {
    return false;
  }

  const resolved = path.resolve(IMAGES_DIR, baseName);
  if (!resolved.startsWith(IMAGES_DIR + path.sep)) {
    return false;
  }

  try {
    fs.unlinkSync(resolved);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn('Could not delete unused dish image:', baseName, code || err);
    }
    return false;
  }
}

// Generate next sequential Order ID (e.g., ORD-1016)
function generateOrderId(orders: OrderRecord[]): string {
  let maxNum = 1000;
  for (const ord of orders) {
    const match = String(ord.id || '').match(/(\d+)$/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  return `ORD-${maxNum + 1}`;
}

/* 
 * LIVE ROLE-BASED AUTHENTICATION MIDDLEWARE
 *  */

function requireAuth(allowedRoles?: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    }
    const verified = verifyAuthToken(token);
    if (!verified) {
      return res.status(401).json({ error: 'Session expired or invalid token. Please sign in again.' });
    }
    const db = readDB();
    const user = db.users.find((u) => String(u.id) === String(verified.uid));
    if (!user) {
      return res.status(401).json({ error: 'Account no longer exists. Please sign in again.' });
    }
    if (Array.isArray(allowedRoles) && !allowedRoles.includes(user.role)) {
      return res.status(403).json({ error: 'Access denied. Insufficient permissions.' });
    }
    req.currentUser = user;
    next();
  };
}

/* ============================================================================
 * 1. HEALTH CHECK & AUTHENTICATION ROUTES
 * ========================================================================== */

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/auth/login', (req: Request, res: Response) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const db = readDB();
  const user = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const check = verifyPassword(password, user.password);
  if (!check.valid) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  // Transparently upgrade any legacy plaintext entry to scrypt hash
  if (check.needsUpgrade) {
    user.password = hashPassword(password);
    writeDB(db);
  }

  const token = signAuthToken(user.id);
  return res.json({ token, user: sanitizeUser(user) });
});

app.get('/api/auth/me', requireAuth(['staff', 'admin']), (req: AuthenticatedRequest, res: Response) => {
  return res.json({ user: sanitizeUser(req.currentUser!) });
});

/* ============================================================================
 * 2. SILENT CUSTOMER BEHAVIOR TRACKING ROUTE
 * ========================================================================== */

app.post('/api/track', (req: Request, res: Response) => {
  const { type, itemId, itemName, category } = req.body || {};
  const db = readDB();
  const now = new Date().toISOString();

  if (type === 'page_view') {
    db.tracking.pageViews.push({ timestamp: now });
    if (db.tracking.pageViews.length > MAX_TRACKING_ENTRIES) {
      db.tracking.pageViews = db.tracking.pageViews.slice(-MAX_TRACKING_ENTRIES);
    }
    writeDB(db);
    return res.status(201).json({ tracked: true });
  }

  if (type === 'menu_click') {
    if (!itemId && !itemName) {
      return res.status(400).json({ error: 'Missing dish metadata for menu_click.' });
    }
    const foundItem = db.menu.find((m) => String(m.id) === String(itemId));
    db.tracking.menuClicks.push({
      itemId: foundItem ? String(foundItem.id) : String(itemId || ''),
      itemName: foundItem ? foundItem.name : String(itemName || '').slice(0, 120),
      category: foundItem ? foundItem.category : String(category || 'Mains').slice(0, 60),
      timestamp: now
    });
    if (db.tracking.menuClicks.length > MAX_TRACKING_ENTRIES) {
      db.tracking.menuClicks = db.tracking.menuClicks.slice(-MAX_TRACKING_ENTRIES);
    }
    writeDB(db);
    return res.status(201).json({ tracked: true });
  }

  if (type === 'category_click') {
    return res.status(200).json({ tracked: true, category: String(category || 'All').slice(0, 60) });
  }

  return res.status(400).json({ error: 'Unsupported tracking event type.' });
});

/* ============================================================================
 * 3. MENU ROUTES (Specific routes registered BEFORE /:id)
 * ========================================================================== */

app.get('/api/menu', (_req: Request, res: Response) => {
  const db = readDB();
  res.json(db.menu);
});

app.post('/api/menu', requireAuth(['admin']), (req: AuthenticatedRequest, res: Response) => {
  const { name, description, category, price, cost, image, available } = req.body || {};

  const cleanName = String(name || '').trim();
  const cleanDesc = String(description || '').trim();
  const cleanCat = VALID_CATEGORIES.includes(category) ? category : 'Mains';
  const numPrice = Number(price);
  const numCost = Number(cost);

  if (!cleanName) {
    return res.status(400).json({ error: 'Dish name is required.' });
  }
  if (!Number.isFinite(numPrice) || numPrice <= 0) {
    return res.status(400).json({ error: 'Selling price must be greater than 0.' });
  }
  if (!Number.isFinite(numCost) || numCost < 0) {
    return res.status(400).json({ error: 'Estimated cost must be 0 or greater.' });
  }

  const db = readDB();
  const newItem: MenuItem = {
    id: `m${Date.now()}`,
    name: cleanName.slice(0, 100),
    description: cleanDesc.slice(0, 220) || 'Signature elevated lutong bahay classic.',
    category: cleanCat,
    price: Math.round(numPrice * 100) / 100,
    cost: Math.round(numCost * 100) / 100,
    image: normalizeImagePath(image),
    available: available !== false
  };

  db.menu.push(newItem);
  if (!writeDB(db)) {
    return res.status(500).json({ error: 'Failed to save menu item.' });
  }
  return res.status(201).json(newItem);
});

// Admin-only direct dish photo upload (registered BEFORE /api/menu/:id)
app.post('/api/menu/upload-image', requireAuth(['admin']), (req: AuthenticatedRequest, res: Response) => {
  const dataUrl = typeof req.body?.dataUrl === 'string' ? req.body.dataUrl.trim() : '';
  const rawFilename = typeof req.body?.filename === 'string' ? req.body.filename.trim() : 'dish';

  const match = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return res.status(400).json({ error: 'Unsupported image format. Please upload JPG, PNG, WebP, or GIF.' });
  }

  const mimeSubtype = match[1].toLowerCase();
  const ext = mimeSubtype === 'jpeg' ? 'jpg' : mimeSubtype;
  const base64Payload = match[2].replace(/\s+/g, '');

  let decoded: Buffer;
  try {
    decoded = Buffer.from(base64Payload, 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid image payload.' });
  }

  if (decoded.length === 0) {
    return res.status(400).json({ error: 'Uploaded image is empty.' });
  }
  if (decoded.length > MAX_IMAGE_DECODED_BYTES) {
    return res.status(413).json({ error: 'Image exceeds the 5MB upload limit after optimization.' });
  }
  if (!verifyImageMagicBytes(decoded, ext)) {
    return res.status(400).json({ error: 'File contents do not match a valid JPG, PNG, WebP, or GIF image.' });
  }

  const baseWithoutExt = path.basename(rawFilename, path.extname(rawFilename));
  const slug = baseWithoutExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'photo';

  const storedFilename = `dish-${slug}-${Date.now()}.${ext}`;
  const destPath = path.resolve(IMAGES_DIR, storedFilename);
  if (!destPath.startsWith(IMAGES_DIR + path.sep)) {
    return res.status(400).json({ error: 'Invalid target image filename.' });
  }

  try {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.writeFileSync(destPath, decoded);
  } catch (err) {
    console.error('Error saving uploaded dish image:', err instanceof Error ? err.message : err);
    return res.status(500).json({ error: 'Failed to save uploaded image on server.' });
  }

  return res.status(201).json({ image: `./images/${storedFilename}` });
});

// Staff & Admin quick stock toggle (registered BEFORE /api/menu/:id)
app.patch('/api/menu/:id/toggle', requireAuth(['staff', 'admin']), (req: AuthenticatedRequest, res: Response) => {
  const db = readDB();
  const item = db.menu.find((m) => String(m.id) === String(req.params.id));
  if (!item) {
    return res.status(404).json({ error: 'Menu item not found.' });
  }

  item.available = typeof req.body?.available === 'boolean' ? req.body.available : !item.available;
  if (!writeDB(db)) {
    return res.status(500).json({ error: 'Failed to update stock status.' });
  }
  return res.json(item);
});

app.put('/api/menu/:id', requireAuth(['admin']), (req: AuthenticatedRequest, res: Response) => {
  const db = readDB();
  const item = db.menu.find((m) => String(m.id) === String(req.params.id));
  if (!item) {
    return res.status(404).json({ error: 'Menu item not found.' });
  }

  const { name, description, category, price, cost, image, available } = req.body || {};
  const cleanName = String(name || '').trim();
  const cleanDesc = String(description || '').trim();
  const numPrice = Number(price);
  const numCost = Number(cost);

  if (!cleanName) {
    return res.status(400).json({ error: 'Dish name is required.' });
  }
  if (!Number.isFinite(numPrice) || numPrice <= 0) {
    return res.status(400).json({ error: 'Selling price must be greater than 0.' });
  }
  if (!Number.isFinite(numCost) || numCost < 0) {
    return res.status(400).json({ error: 'Estimated cost must be 0 or greater.' });
  }

  const previousImage = item.image;

  item.name = cleanName.slice(0, 100);
  item.description = cleanDesc.slice(0, 220) || item.description;
  item.category = VALID_CATEGORIES.includes(category) ? category : item.category;
  item.price = Math.round(numPrice * 100) / 100;
  item.cost = Math.round(numCost * 100) / 100;
  item.image = normalizeImagePath(image);
  if (typeof available === 'boolean') {
    item.available = available;
  }

  if (!writeDB(db)) {
    return res.status(500).json({ error: 'Failed to update menu item.' });
  }

  if (previousImage !== item.image) {
    safeDeleteImageIfUnused(previousImage, db);
  }

  return res.json(item);
});

app.delete('/api/menu/:id', requireAuth(['admin']), (req: AuthenticatedRequest, res: Response) => {
  const db = readDB();
  const idx = db.menu.findIndex((m) => String(m.id) === String(req.params.id));
  if (idx === -1) {
    return res.status(404).json({ error: 'Menu item not found.' });
  }

  const [removed] = db.menu.splice(idx, 1);
  if (!writeDB(db)) {
    return res.status(500).json({ error: 'Failed to delete menu item.' });
  }

  safeDeleteImageIfUnused(removed.image, db);

  return res.json({ deleted: true, item: removed });
});

/* ============================================================================
 * 4. ORDER ROUTES (Specific routes registered BEFORE /:id)
 * ========================================================================== */

// Public order tracking by Order ID
app.get('/api/orders/track/:id', (req: Request, res: Response) => {
  const queryId = String(req.params.id || '').trim().toUpperCase();
  if (!queryId) {
    return res.status(400).json({ error: 'Please enter an Order ID.' });
  }

  const db = readDB();
  const order = db.orders.find((o) => String(o.id).toUpperCase() === queryId);
  if (!order) {
    return res.status(404).json({ error: `Order "${queryId}" was not found.` });
  }

  // Return public-safe order summary (omit internal cost breakdown)
  return res.json({
    id: order.id,
    customerName: order.customerName,
    orderType: order.orderType,
    tableNumber: order.tableNumber,
    source: order.source,
    status: order.status,
    total: order.total,
    rating: order.rating,
    createdAt: order.createdAt,
    items: (order.items || []).map((i) => ({
      itemId: i.itemId,
      name: i.name,
      category: i.category,
      qty: i.qty,
      price: i.price
    }))
  });
});

// Public customer 1-5 star rating for completed orders
app.patch('/api/orders/:id/rate', (req: Request, res: Response) => {
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
  }

  const db = readDB();
  const order = db.orders.find(
    (o) => String(o.id).toUpperCase() === String(req.params.id || '').trim().toUpperCase()
  );

  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }
  if (order.status !== 'Completed') {
    return res.status(400).json({ error: 'Only completed orders can be rated.' });
  }
  if (order.rating !== null && order.rating !== undefined) {
    return res.status(400).json({ error: 'This order has already been rated.' });
  }

  order.rating = rating;
  if (!writeDB(db)) {
    return res.status(500).json({ error: 'Failed to save rating.' });
  }
  return res.json({ id: order.id, rating: order.rating });
});

// Create a new Order (Online public OR Walk-In POS authenticated)
app.post('/api/orders', (req: Request, res: Response) => {
  const { customerName, orderType, tableNumber, items, source, browseDurationSec } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must contain at least one menu item.' });
  }

  const db = readDB();
  let finalSource: 'Online' | 'Walk-In POS' = 'Online';
  let recordedBy = 'Online';

  // Verify Walk-In POS authorization against signed token & live database users
  if (source === 'Walk-In POS') {
    const token = extractBearerToken(req);
    const verified = token ? verifyAuthToken(token) : null;
    const authUser = verified ? db.users.find((u) => String(u.id) === String(verified.uid)) : null;
    if (!authUser) {
      return res.status(401).json({ error: 'Staff or Admin login required to record Walk-In POS orders.' });
    }
    finalSource = 'Walk-In POS';
    recordedBy = authUser.username;
  }

  const cleanCustomer = String(customerName || '').trim();
  const resolvedCustomer =
    finalSource === 'Walk-In POS' ? cleanCustomer || 'Walk-in' : cleanCustomer;

  if (!resolvedCustomer) {
    return res.status(400).json({ error: 'Customer name is required.' });
  }

  const cleanType: 'Dine-In' | 'Take-Out' = orderType === 'Take-Out' ? 'Take-Out' : 'Dine-In';
  const cleanTable = cleanType === 'Dine-In' ? String(tableNumber || '').trim().slice(0, 20) : '';

  // Compute authoritative totals strictly from server menu prices and costs
  const orderItems: OrderItem[] = [];
  let total = 0;
  let totalCost = 0;

  for (const entry of items) {
    const menuItem = db.menu.find((m) => String(m.id) === String(entry?.itemId || entry?.id));
    if (!menuItem) {
      return res.status(400).json({ error: 'One or more selected menu items no longer exist.' });
    }
    if (!menuItem.available) {
      return res.status(400).json({ error: `"${menuItem.name}" is currently out of stock.` });
    }
    const qty = Math.floor(Number(entry?.qty));
    if (!Number.isFinite(qty) || qty < 1 || qty > 99) {
      return res.status(400).json({ error: `Invalid quantity for "${menuItem.name}".` });
    }

    orderItems.push({
      itemId: String(menuItem.id),
      name: menuItem.name,
      category: menuItem.category,
      qty,
      price: menuItem.price,
      cost: menuItem.cost
    });
    total += menuItem.price * qty;
    totalCost += menuItem.cost * qty;
  }

  // Clamp online menu browse duration server-side (1s to 3600s)
  let safeBrowseSec: number | null = null;
  if (finalSource === 'Online' && browseDurationSec !== null && browseDurationSec !== undefined) {
    const parsedSec = Math.round(Number(browseDurationSec));
    if (Number.isFinite(parsedSec) && parsedSec >= 1 && parsedSec <= 3600) {
      safeBrowseSec = parsedSec;
    }
  }

  const newOrder: OrderRecord = {
    id: generateOrderId(db.orders),
    customerName: resolvedCustomer.slice(0, 80),
    orderType: cleanType,
    tableNumber: cleanTable,
    source: finalSource,
    recordedBy,
    items: orderItems,
    total: Math.round(total * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
    browseDurationSec: safeBrowseSec,
    status: 'Pending',
    rating: null,
    createdAt: new Date().toISOString()
  };

  db.orders.push(newOrder);
  if (!writeDB(db)) {
    return res.status(500).json({ error: 'Failed to record order.' });
  }
  return res.status(201).json(newOrder);
});

// Get all orders (Staff & Admin)
app.get('/api/orders', requireAuth(['staff', 'admin']), (_req: AuthenticatedRequest, res: Response) => {
  const db = readDB();
  const sorted = [...db.orders].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json(sorted);
});

// Update order status (Staff & Admin)
app.patch('/api/orders/:id', requireAuth(['staff', 'admin']), (req: AuthenticatedRequest, res: Response) => {
  const status = req.body?.status as OrderStatus;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid order status.' });
  }

  const db = readDB();
  const order = db.orders.find((o) => String(o.id) === String(req.params.id));
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  order.status = status;
  if (!writeDB(db)) {
    return res.status(500).json({ error: 'Failed to update order status.' });
  }
  return res.json(order);
});

// Delete order (Admin only)
app.delete('/api/orders/:id', requireAuth(['admin']), (req: AuthenticatedRequest, res: Response) => {
  const db = readDB();
  const idx = db.orders.findIndex((o) => String(o.id) === String(req.params.id));
  if (idx === -1) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const [removed] = db.orders.splice(idx, 1);
  if (!writeDB(db)) {
    return res.status(500).json({ error: 'Failed to delete order.' });
  }
  return res.json({ deleted: true, id: removed.id });
});

/* ============================================================================
 * 5. ANALYTICS & SETTINGS ROUTES (Admin Only)
 * ========================================================================== */

app.get('/api/analytics', requireAuth(['admin']), (_req: AuthenticatedRequest, res: Response) => {
  const db = readDB();
  res.json({
    settings: db.settings,
    menu: db.menu,
    orders: db.orders,
    tracking: db.tracking,
    users: db.users.map(sanitizeUser)
  });
});

app.put('/api/settings', requireAuth(['admin']), (req: AuthenticatedRequest, res: Response) => {
  const target = Number(req.body?.dailyTarget);
  if (!Number.isFinite(target) || target <= 0) {
    return res.status(400).json({ error: 'Daily revenue target must be greater than 0.' });
  }

  const db = readDB();
  db.settings.dailyTarget = Math.round(target * 100) / 100;
  if (!writeDB(db)) {
    return res.status(500).json({ error: 'Failed to save daily revenue target.' });
  }
  return res.json(db.settings);
});

/* ============================================================================
 * 6. ACCOUNT MANAGEMENT ROUTES (Admin Only)
 * ========================================================================== */

app.get('/api/users', requireAuth(['admin']), (_req: AuthenticatedRequest, res: Response) => {
  const db = readDB();
  res.json(db.users.map(sanitizeUser));
});

app.post('/api/users', requireAuth(['admin']), (req: AuthenticatedRequest, res: Response) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const role: Role = VALID_ROLES.includes(req.body?.role) ? req.body.role : 'staff';

  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  }

  const db = readDB();
  const exists = db.users.some((u) => u.username.toLowerCase() === username.toLowerCase());
  if (exists) {
    return res.status(409).json({ error: `Username "${username}" already exists.` });
  }

  const newUser: UserRecord = {
    id: `u${Date.now()}`,
    username: username.slice(0, 40),
    password: hashPassword(password),
    role
  };

  db.users.push(newUser);
  if (!writeDB(db)) {
    return res.status(500).json({ error: 'Failed to create account.' });
  }
  return res.status(201).json(sanitizeUser(newUser));
});

app.put('/api/users/:id', requireAuth(['admin']), (req: AuthenticatedRequest, res: Response) => {
  const db = readDB();
  const user = db.users.find((u) => String(u.id) === String(req.params.id));
  if (!user) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  const username = String(req.body?.username || '').trim();
  const role: Role = VALID_ROLES.includes(req.body?.role) ? req.body.role : user.role;
  const rawPassword =
    req.body?.password !== undefined && req.body?.password !== null
      ? String(req.body.password)
      : '';

  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters.' });
  }

  // Case-insensitive duplicate check excluding this account
  const duplicate = db.users.some(
    (u) => String(u.id) !== String(user.id) && u.username.toLowerCase() === username.toLowerCase()
  );
  if (duplicate) {
    return res.status(409).json({ error: `Username "${username}" is already taken.` });
  }

  // Prevent demoting the last remaining Admin account
  if (user.role === 'admin' && role !== 'admin') {
    const adminCount = db.users.filter((u) => u.role === 'admin').length;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Cannot change role of the last remaining Admin.' });
    }
  }

  // Keep existing password intact when left blank
  if (rawPassword.length > 0) {
    if (rawPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters.' });
    }
    user.password = hashPassword(rawPassword);
  }

  user.username = username.slice(0, 40);
  user.role = role;

  if (!writeDB(db)) {
    return res.status(500).json({ error: 'Failed to update account.' });
  }
  return res.json(sanitizeUser(user));
});

app.delete('/api/users/:id', requireAuth(['admin']), (req: AuthenticatedRequest, res: Response) => {
  const db = readDB();
  const idx = db.users.findIndex((u) => String(u.id) === String(req.params.id));
  if (idx === -1) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  const target = db.users[idx];
  if (String(target.id) === String(req.currentUser?.id)) {
    return res.status(400).json({ error: 'You cannot delete your own active account.' });
  }

  if (target.role === 'admin') {
    const adminCount = db.users.filter((u) => u.role === 'admin').length;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last remaining Admin account.' });
    }
  }

  db.users.splice(idx, 1);
  if (!writeDB(db)) {
    return res.status(500).json({ error: 'Failed to delete account.' });
  }
  return res.json({ deleted: true, id: target.id });
});

/* ============================================================================
 * 7. CLEAN API 404, ROOT ROUTE & GLOBAL ERROR HANDLERS
 * ========================================================================== */

app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Bind to 0.0.0.0 and process.env.PORT for Render/Railway and local preview
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Kusina Moderna server running on http://localhost:${PORT}`);
});
