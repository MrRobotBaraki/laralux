import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, runTransaction, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, LOGIN_DOMAIN, ADMIN_USERNAME } from "./firebase-config.js?v=4";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const ADMIN_EMAIL = `${ADMIN_USERNAME}@${LOGIN_DOMAIN}`;
const STARTER_MODEL_COUNT = 29;

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let settings = { deliveryFee: 800, currency: "DA", deliveryPrices: {} };
const DEFAULT_PRICE = 2500;

// The 58 wilayas of Algeria
const WILAYAS = ["Adrar", "Chlef", "Laghouat", "Oum El Bouaghi", "Batna", "Béjaïa", "Biskra", "Béchar", "Blida",
  "Bouira", "Tamanrasset", "Tébessa", "Tlemcen", "Tiaret", "Tizi Ouzou", "Alger", "Djelfa", "Jijel", "Sétif",
  "Saïda", "Skikda", "Sidi Bel Abbès", "Annaba", "Guelma", "Constantine", "Médéa", "Mostaganem", "M'Sila",
  "Mascara", "Ouargla", "Oran", "El Bayadh", "Illizi", "Bordj Bou Arréridj", "Boumerdès", "El Tarf", "Tindouf",
  "Tissemsilt", "El Oued", "Khenchela", "Souk Ahras", "Tipaza", "Mila", "Aïn Defla", "Naâma", "Aïn Témouchent",
  "Ghardaïa", "Relizane", "Timimoun", "Bordj Badji Mokhtar", "Ouled Djellal", "Béni Abbès", "In Salah",
  "In Guezzam", "Touggourt", "Djanet", "El M'Ghair", "El Meniaa"]
  .map((name, i) => ({ code: String(i + 1).padStart(2, "0"), name }));
const wilayaLabel = (code) => { const w = WILAYAS.find((x) => x.code === code); return w ? `${w.code} - ${w.name}` : ""; };
const deliveryFor = (code) => {
  const p = settings.deliveryPrices?.[code];
  return Number(p ?? settings.deliveryFee ?? 0) || 0;
};
const money = (n) => `${Number(n || 0).toLocaleString("fr-FR")} ${settings.currency}`;
let unsubs = [];
const clearSubs = () => { unsubs.forEach((u) => u()); unsubs = []; };

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

function show(view) {
  for (const v of ["view-loading", "view-login", "view-shop", "view-admin"]) $(v).classList.toggle("hidden", v !== view);
  $("topbar").classList.toggle("hidden", !(view === "view-shop" || view === "view-admin"));
}

// Resize an image file to a JPEG data URL (keeps database entries small)
function fileToJpeg(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("Could not read this image."));
    img.src = URL.createObjectURL(file);
  });
}
const makeImages = async (file) => ({
  image: await fileToJpeg(file, 800, 0.72),
  thumb: await fileToJpeg(file, 220, 0.7),
});

function watchSettings() {
  unsubs.push(onSnapshot(doc(db, "settings", "shop"), (s) => {
    if (s.exists()) settings = { ...settings, ...s.data() };
    renderWilayaOptions();
    renderCart?.();
    renderWilayaPrices?.();
  }));
}

// ---------- auth ----------
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const user = $("login-user").value.trim().toLowerCase();
  const pass = $("login-pass").value.trim();
  $("login-error").textContent = "";
  $("login-btn").disabled = true;
  try {
    await signInWithEmailAndPassword(auth, `${user}@${LOGIN_DOMAIN}`, pass);
  } catch (err) {
    $("login-error").textContent =
      err.code === "auth/too-many-requests" ? "Too many attempts. Please wait a moment and try again."
      : err.code === "auth/network-request-failed" ? "No internet connection."
      : ["auth/invalid-credential", "auth/invalid-login-credentials", "auth/wrong-password",
         "auth/user-not-found", "auth/invalid-email"].includes(err.code)
        ? "Wrong username or password."
        : "Login problem (" + (err.code || err.message) + "). Please refresh the page and try again.";
  } finally {
    $("login-btn").disabled = false;
  }
});
$("logout-btn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  clearSubs();
  if (!user) { $("login-pass").value = ""; show("view-login"); return; }
  const isAdmin = user.email === ADMIN_EMAIL;
  $("who").textContent = isAdmin ? "Admin" : "Client";
  watchSettings();
  if (isAdmin) startAdmin(); else startShop();
});

// =====================================================================
// CLIENT SHOP
// =====================================================================
let models = [];
const cart = new Map(); // modelId -> qty
let renderCart = null;
let renderWilayaPrices = null;

function renderWilayaOptions() {
  const sel = $("c-wilaya");
  const current = sel.value;
  sel.innerHTML = `<option value="">— Choose your state —</option>` + WILAYAS.map((w) =>
    `<option value="${w.code}">${w.code} - ${esc(w.name)} (delivery ${money(deliveryFor(w.code))})</option>`).join("");
  sel.value = current;
}

function startShop() {
  show("view-shop");
  cart.clear();
  unsubs.push(onSnapshot(query(collection(db, "models"), orderBy("order")), (snap) => {
    models = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((m) => m.price > 0);
    // keep cart consistent with live stock
    for (const [id, q] of cart) {
      const m = models.find((x) => x.id === id);
      if (!m || m.stock <= 0) cart.delete(id); else if (q > m.stock) cart.set(id, m.stock);
    }
    renderShop();
    renderCart();
  }, (err) => toast("Could not load models: " + err.message)));
}

function renderShop() {
  $("shop-empty").classList.toggle("hidden", models.length > 0);
  $("shop-grid").innerHTML = models.map((m) => {
    const sold = m.stock <= 0;
    const sel = cart.has(m.id);
    const details = [m.size, m.colors].filter(Boolean).map(esc).join(" · ");
    return `
      <article class="model ${sold ? "soldout" : ""} ${sel ? "selected" : ""}" data-id="${m.id}" tabindex="0" role="button" aria-pressed="${sel}">
        ${sel ? `<span class="check">✓</span>` : ""}
        <img src="${esc(m.image)}" alt="${esc(m.name)}" loading="lazy">
        <div class="model-body">
          <div class="model-name">${esc(m.name)}</div>
          ${details ? `<div class="small muted">${details}</div>` : ""}
          ${m.description ? `<div class="small muted">${esc(m.description)}</div>` : ""}
          <div class="model-price">${money(m.price)}</div>
          <div class="stock ${m.stock > 0 && m.stock <= 3 ? "low" : ""}">${sold ? "Sold out" : `${m.stock} left`}</div>
        </div>
      </article>`;
  }).join("");
}

function toggleModel(id) {
  const m = models.find((x) => x.id === id);
  if (!m || m.stock <= 0) return;
  if (cart.has(id)) cart.delete(id); else cart.set(id, 1);
  renderShop();
  renderCart();
}
$("shop-grid").addEventListener("click", (e) => {
  const card = e.target.closest(".model");
  if (card) toggleModel(card.dataset.id);
});
$("shop-grid").addEventListener("keydown", (e) => {
  const card = e.target.closest(".model");
  if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleModel(card.dataset.id); }
});

$("cart-items").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const id = b.dataset.id;
  const m = models.find((x) => x.id === id);
  let q = cart.get(id) || 0;
  if (b.dataset.act === "plus") {
    if (q >= m.stock) { toast(`Only ${m.stock} left of ${m.name}`); return; }
    q++;
  } else q--;
  if (q <= 0) cart.delete(id); else cart.set(id, q);
  renderShop();
  renderCart();
});

const phoneOk = (p) => p.replace(/\D/g, "").length >= 9;

renderCart = function () {
  if ($("view-shop").classList.contains("hidden")) return;
  const items = [...cart].map(([id, qty]) => ({ m: models.find((x) => x.id === id), qty })).filter((i) => i.m);
  $("cart-empty").classList.toggle("hidden", items.length > 0);
  $("cart-items").innerHTML = items.map(({ m, qty }) => `
    <div class="cart-item">
      <img src="${esc(m.thumb || m.image)}" alt="">
      <div><div class="nm">${esc(m.name)}</div><div class="small muted">${money(m.price)} × ${qty}</div></div>
      <div class="qty">
        <button type="button" data-act="minus" data-id="${m.id}" aria-label="Less">−</button>
        <span>${qty}</span>
        <button type="button" data-act="plus" data-id="${m.id}" aria-label="More">+</button>
      </div>
    </div>`).join("");

  const sub = items.reduce((s, i) => s + i.m.price * i.qty, 0);
  const wilaya = $("c-wilaya").value;
  const del = wilaya ? deliveryFor(wilaya) : 0;
  $("t-sub").textContent = money(sub);
  $("t-del").textContent = wilaya ? `${money(del)} (${WILAYAS.find((w) => w.code === wilaya).name})` : "choose your state";
  $("t-total").textContent = money(sub + (items.length ? del : 0));

  const missing = [];
  if (!items.length) missing.push("choose at least one model");
  if (!$("c-name").value.trim()) missing.push("your name");
  if (!phoneOk($("c-phone").value)) missing.push("a valid phone");
  if (!wilaya) missing.push("your state");
  if (!$("c-address").value.trim()) missing.push("your address");
  $("order-hint").textContent = missing.length ? "To confirm, please add: " + missing.join(", ") + "." : "";
  $("confirm-btn").classList.toggle("hidden", missing.length > 0);
};
for (const id of ["c-name", "c-phone", "c-address", "c-wilaya"]) $(id).addEventListener("input", () => renderCart());
$("c-wilaya").addEventListener("change", () => renderCart());

$("order-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!cart.size) return;
  const btn = $("confirm-btn");
  btn.disabled = true;
  btn.textContent = "Sending…";
  $("order-error").textContent = "";
  const orderRef = doc(collection(db, "orders"));
  try {
    await runTransaction(db, async (tx) => {
      const entries = [...cart];
      const refs = entries.map(([id]) => doc(db, "models", id));
      const snaps = await Promise.all(refs.map((r) => tx.get(r)));
      const items = [];
      snaps.forEach((s, i) => {
        const qty = entries[i][1];
        if (!s.exists()) throw new Error("A model in your order is no longer available.");
        const m = s.data();
        if (m.stock < qty) throw new Error(`Sorry, only ${m.stock} left of ${m.name}.`);
        items.push({ modelId: s.id, name: m.name, price: m.price, qty, thumb: m.thumb || m.image,
                     size: m.size || "", colors: m.colors || "" });
      });
      snaps.forEach((s, i) => tx.update(refs[i], { stock: s.data().stock - entries[i][1] }));
      const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
      const wilaya = $("c-wilaya").value;
      if (!wilaya) throw new Error("Please choose your state.");
      const delivery = deliveryFor(wilaya);
      tx.set(orderRef, {
        customer: { name: $("c-name").value.trim(), phone: $("c-phone").value.trim(),
                    wilaya: wilayaLabel(wilaya), address: $("c-address").value.trim() },
        items, subtotal, delivery, total: subtotal + delivery, currency: settings.currency,
        status: "new", createdAt: serverTimestamp(),
      });
    });
    cart.clear();
    $("order-form").reset();
    renderShop();
    renderCart();
    $("success-ref").textContent = "Order reference: " + orderRef.id.slice(0, 8).toUpperCase();
    $("success").classList.remove("hidden");
  } catch (err) {
    $("order-error").textContent = err.message || "Could not send the order. Please try again.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Confirm order";
  }
});
$("success-ok").addEventListener("click", () => $("success").classList.add("hidden"));

// =====================================================================
// ADMIN
// =====================================================================
let orders = [];
let adminModels = [];

async function startAdmin() {
  show("view-admin");
  try { await ensureStarterData(); } catch (err) { toast("Setup error: " + err.message); }
  unsubs.push(onSnapshot(query(collection(db, "orders"), orderBy("createdAt", "desc")), (snap) => {
    orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderOrders();
  }, (err) => toast("Could not load orders: " + err.message)));
  unsubs.push(onSnapshot(query(collection(db, "models"), orderBy("order")), (snap) => {
    adminModels = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAdminModels();
  }));
  pricesDirty = false;
  renderWilayaPrices();
}

// ---------- settings: delivery prices per wilaya ----------
let pricesDirty = false; // don't overwrite what the admin is typing
renderWilayaPrices = function () {
  if ($("view-admin").classList.contains("hidden") || pricesDirty) return;
  $("s-currency").value = settings.currency ?? "DA";
  $("wilaya-prices").innerHTML = WILAYAS.map((w) => `
    <label><span>${w.code} - ${esc(w.name)}</span>
      <input type="number" min="0" step="1" data-w="${w.code}" value="${deliveryFor(w.code)}"></label>`).join("");
};
$("settings-form").addEventListener("input", () => { pricesDirty = true; });
$("d-all-btn").addEventListener("click", () => {
  const v = $("d-all").value;
  if (v === "") return;
  pricesDirty = true;
  document.querySelectorAll("#wilaya-prices input").forEach((i) => (i.value = v));
});

$("p-all-btn").addEventListener("click", async () => {
  const price = Math.max(0, Number($("p-all").value) || 0);
  if (!confirm(`Set the price of all ${adminModels.length} models to ${money(price)}?`)) return;
  const btn = $("p-all-btn");
  btn.disabled = true;
  try {
    const batch = writeBatch(db);
    adminModels.forEach((m) => batch.update(doc(db, "models", m.id), { price }));
    batch.set(doc(db, "settings", "shop"), { defaultPrice: price }, { merge: true });
    await batch.commit();
    $("p-msg").textContent = `All models now cost ${money(price)} ✓`;
  } catch (err) { $("p-msg").textContent = err.message; }
  finally { btn.disabled = false; }
});

// First admin login: create settings and load the 29 models from img/models/
async function ensureStarterData() {
  const ref = doc(db, "settings", "shop");
  const s = await getDoc(ref);
  if (s.exists() && s.data().seeded) return;
  const batch = writeBatch(db);
  for (let i = 1; i <= STARTER_MODEL_COUNT; i++) {
    batch.set(doc(db, "models", `c${i}`), {
      name: `Model ${i}`, price: DEFAULT_PRICE, stock: 10, size: "", colors: "", description: "",
      image: `img/models/c${i}.jpg`, thumb: `img/models/c${i}.jpg`, order: i, createdAt: serverTimestamp(),
    });
  }
  batch.set(ref, { deliveryFee: 800, currency: "DA", seeded: true }, { merge: true });
  await batch.commit();
  toast(`${STARTER_MODEL_COUNT} models added. Set their prices in the Models tab.`);
}

// tabs
document.querySelector(".tabs").addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (!t) return;
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  for (const p of ["orders", "models", "settings"]) $("tab-" + p).classList.toggle("hidden", p !== t.dataset.tab);
});

$("order-filter").addEventListener("change", renderOrders);

function fmtDate(ts) {
  if (!ts?.toDate) return "just now";
  return ts.toDate().toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

function renderOrders() {
  const f = $("order-filter").value;
  const list = orders.filter((o) => f === "all" || o.status === f);
  const newCount = orders.filter((o) => o.status === "new").length;
  $("new-count").textContent = newCount;
  $("new-count").classList.toggle("hidden", !newCount);
  $("orders-empty").classList.toggle("hidden", list.length > 0);
  $("orders-list").innerHTML = list.map((o) => {
    const cur = (n) => `${Number(n || 0).toLocaleString("fr-FR")} ${esc(o.currency || settings.currency)}`;
    return `
    <article class="card order ${o.status === "new" ? "is-new" : ""}">
      <div class="order-head">
        <h3>${esc(o.customer?.name)}</h3>
        <div><span class="status ${esc(o.status)}">${o.status === "new" ? "New" : "Delivered"}</span>
          <span class="small muted">&nbsp;${fmtDate(o.createdAt)} · #${o.id.slice(0, 8).toUpperCase()}</span></div>
      </div>
      <div class="customer">
        <div><b>Phone:</b> <a href="tel:${esc(o.customer?.phone)}">${esc(o.customer?.phone)}</a></div>
        <div><b>State:</b> ${esc(o.customer?.wilaya || "—")}</div>
        <div><b>Address:</b> ${esc(o.customer?.address)}</div>
      </div>
      <div class="order-items">
        ${(o.items || []).map((i) => `
          <div class="order-item">
            <img src="${esc(i.thumb)}" alt="${esc(i.name)}">
            <div><div><b>${esc(i.name)}</b></div>
              ${i.size || i.colors ? `<div class="small muted">${esc([i.size, i.colors].filter(Boolean).join(" · "))}</div>` : ""}
              <div class="small">${i.qty} × ${cur(i.price)}</div></div>
          </div>`).join("")}
      </div>
      <div class="order-foot">
        <div class="small">Subtotal ${cur(o.subtotal)} + delivery ${cur(o.delivery)} = <b style="font-size:17px">${cur(o.total)}</b></div>
        <div class="actions">
          <button class="btn btn-light" data-act="status" data-id="${o.id}">${o.status === "new" ? "Mark delivered" : "Mark as new"}</button>
          <button class="btn btn-danger" data-act="del-order" data-id="${o.id}">Delete</button>
        </div>
      </div>
    </article>`;
  }).join("");
}

$("orders-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const o = orders.find((x) => x.id === b.dataset.id);
  if (!o) return;
  try {
    if (b.dataset.act === "status") {
      await updateDoc(doc(db, "orders", o.id), { status: o.status === "new" ? "delivered" : "new" });
    } else if (confirm(`Delete the order of ${o.customer?.name}?\n(The stock will not be returned.)`)) {
      await deleteDoc(doc(db, "orders", o.id));
      toast("Order deleted");
    }
  } catch (err) { toast(err.message); }
});

function renderAdminModels() {
  $("admin-models").innerHTML = adminModels.map((m) => `
    <div class="am" data-id="${m.id}">
      <img src="${esc(m.image)}" alt="${esc(m.name)}" loading="lazy">
      <div class="am-body">
        <label>Name<input data-f="name" value="${esc(m.name)}"></label>
        <div class="two">
          <label>Price${m.price > 0 ? "" : ' <span class="error">(hidden)</span>'}<input data-f="price" type="number" min="0" value="${esc(m.price)}"></label>
          <label>Stock<input data-f="stock" type="number" min="0" value="${esc(m.stock)}"></label>
        </div>
        <label>Size<input data-f="size" value="${esc(m.size)}"></label>
        <label>Colors<input data-f="colors" value="${esc(m.colors)}"></label>
        <label>Description<textarea data-f="description" rows="2">${esc(m.description)}</textarea></label>
        <label>Change picture<input data-f="file" type="file" accept="image/*"></label>
        <div class="actions">
          <button class="btn btn-gold" data-act="save">Save</button>
          <button class="btn btn-danger" data-act="delete">Delete</button>
        </div>
      </div>
    </div>`).join("");
}

$("admin-models").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const card = b.closest(".am");
  const id = card.dataset.id;
  const m = adminModels.find((x) => x.id === id);
  const val = (f) => card.querySelector(`[data-f="${f}"]`);
  b.disabled = true;
  try {
    if (b.dataset.act === "save") {
      const data = {
        name: val("name").value.trim() || m.name,
        price: Math.max(0, Number(val("price").value) || 0),
        stock: Math.max(0, Math.floor(Number(val("stock").value) || 0)),
        size: val("size").value.trim(),
        colors: val("colors").value.trim(),
        description: val("description").value.trim(),
      };
      const file = val("file").files[0];
      if (file) Object.assign(data, await makeImages(file));
      await updateDoc(doc(db, "models", id), data);
      toast(`${data.name} saved`);
    } else if (confirm(`Delete ${m.name}? Clients will no longer see it.`)) {
      await deleteDoc(doc(db, "models", id));
      toast("Model deleted");
    }
  } catch (err) { toast(err.message); }
  finally { b.disabled = false; }
});

$("m-image").addEventListener("change", () => {
  const f = $("m-image").files[0];
  $("m-preview").classList.toggle("hidden", !f);
  if (f) $("m-preview").src = URL.createObjectURL(f);
});

$("model-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("m-submit");
  btn.disabled = true;
  $("m-error").textContent = "";
  try {
    const imgs = await makeImages($("m-image").files[0]);
    const maxOrder = adminModels.reduce((mx, m) => Math.max(mx, m.order || 0), 0);
    await addDoc(collection(db, "models"), {
      name: $("m-name").value.trim(),
      price: Math.max(0, Number($("m-price").value) || 0),
      stock: Math.max(0, Math.floor(Number($("m-stock").value) || 0)),
      size: $("m-size").value.trim(),
      colors: $("m-colors").value.trim(),
      description: $("m-desc").value.trim(),
      ...imgs, order: maxOrder + 1, createdAt: serverTimestamp(),
    });
    $("model-form").reset();
    $("m-preview").classList.add("hidden");
    toast("Model added");
  } catch (err) {
    $("m-error").textContent = err.message;
  } finally { btn.disabled = false; }
});

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const deliveryPrices = {};
    document.querySelectorAll("#wilaya-prices input").forEach((i) => {
      deliveryPrices[i.dataset.w] = Math.max(0, Math.floor(Number(i.value) || 0));
    });
    await updateDoc(doc(db, "settings", "shop"), { deliveryPrices, currency: $("s-currency").value.trim() || "DA" });
    pricesDirty = false;
    $("s-msg").textContent = "Delivery prices saved ✓";
    setTimeout(() => ($("s-msg").textContent = ""), 2000);
  } catch (err) { $("s-msg").textContent = err.message; }
});
