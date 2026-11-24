// AgriSense mock Equipment Service API (POC)
// In-memory only: data resets when the server restarts.
//
// Used by Equipment_Service_Agent (agent side):
//   POST /service-requests              create a request -> { request_id, status, message }
//   GET  /service-requests/:id          status           -> { request_id, status, message, ... }
//   POST /service-requests/:id/cancel   cancel           -> { request_id, status, message }
//
// Used by the Equipment Service Workflow (back office):
//   GET  /mechanics?zip=50010           mechanics that serve a ZIP
//   POST /service-requests/:id/status   set status (PENDING_APPROVAL, COMPLETED, ...)
//   POST /bookings                      create booking (idempotent per request_id) -> CONFIRMED
//   POST /notify                        mock SMS (logged to console)

const express = require("express");
const app = express();
app.use(express.json());
app.set("trust proxy", true);
const path = require("path");
const fs = require("fs");
const IMG_DIR = path.join(__dirname, "public", "images");
app.use("/images", express.static(IMG_DIR, { maxAge: "7d" }));

const PORT = process.env.PORT || 3000;

// ---------- demo data ----------
const ZIPS = {
  "50010": { county: "Story County", state: "IA" },
  "50011": { county: "Story County", state: "IA" },
  "50014": { county: "Story County", state: "IA" },
  "50309": { county: "Polk County", state: "IA" },
  "68508": { county: "Lancaster County", state: "NE" },
  "61602": { county: "Peoria County", state: "IL" },
};

const MECHANICS = [
  { mechanic_id: "MECH-101", name: "Mike's Farm Repair", phone: "(515) 555-0101",
    zips: ["50010", "50011", "50014"], next_slot: "tomorrow 10:00 AM", available: true },
  { mechanic_id: "MECH-102", name: "Heartland Ag Service", phone: "(515) 555-0102",
    zips: ["50010", "50309"], next_slot: "tomorrow 2:00 PM", available: true },
  { mechanic_id: "MECH-103", name: "Prairie Tractor Works", phone: "(402) 555-0103",
    zips: ["68508"], next_slot: null, available: false },
  { mechanic_id: "MECH-104", name: "River Valley Equipment", phone: "(309) 555-0104",
    zips: ["61602"], next_slot: "Friday 9:00 AM", available: true },
];

const STATUS_TEXT = {
  REQUEST_RECEIVED: "We have your request and are finding a mechanic.",
  PENDING_APPROVAL: "A mechanic has been found and is waiting for coordinator approval.",
  CONFIRMED: "Your mechanic visit is confirmed.",
  COMPLETED: "Your repair has been completed.",
  CANCELLED: "This request was cancelled.",
  NO_MECHANIC: "We could not find a mechanic yet. A coordinator is looking into it.",
};

const requests = new Map(); // request_id -> record
const bookings = new Map(); // request_id -> booking
let counter = 1000;

// ---------- helpers ----------
// Accepts "AGR-SRV-1001", "agr srv 1001", "1001" (handy for voice input)
function normalizeId(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits ? `AGR-SRV-${digits}` : null;
}

function statusMessage(r) {
  let msg = STATUS_TEXT[r.status] || r.status;
  if (r.status === "CONFIRMED" && r.booking) {
    msg = `Confirmed: ${r.booking.mechanic_name} will visit ${r.booking.slot}.`;
  }
  return msg;
}

function publicView(r) {
  return {
    request_id: r.request_id,
    status: r.status,
    message: statusMessage(r),
    equipment: r.equipment,
    brand: r.brand,
    issue: r.issue,
    zip_code: r.zip_code,
    county: r.county,
    state: r.state,
    preferred_day: r.preferred_day,
    booking: r.booking || null,
    updated_at: r.updated_at,
  };
}

function findRequest(req, res) {
  const id = normalizeId(req.params.id);
  const r = id && requests.get(id);
  if (!r) {
    res.status(404).json({ error: "not_found", message: "I can't find that request. Please check the number." });
    return null;
  }
  return r;
}

// ---------- agent endpoints ----------
app.post("/service-requests", (req, res) => {
  const { equipment, brand, issue, zip_code, preferred_day, phone_number } = req.body || {};
  const missing = ["equipment", "issue", "zip_code", "phone_number"].filter((k) => !req.body?.[k]);
  if (missing.length) {
    return res.status(400).json({ error: "missing_fields", missing });
  }
  const zip = String(zip_code).replace(/\D/g, "").slice(0, 5);
  if (zip.length !== 5) return res.status(400).json({ error: "invalid_zip" });

  // Idempotency: same phone + issue + day within 10 minutes returns the existing request
  const now = Date.now();
  for (const r of requests.values()) {
    if (r.phone_number === phone_number && r.issue === issue &&
        r.preferred_day === preferred_day && now - r.created_ms < 10 * 60 * 1000) {
      return res.status(200).json({ request_id: r.request_id, status: r.status, message: statusMessage(r), duplicate: true });
    }
  }

  counter += 1;
  const loc = ZIPS[zip] || { county: "Unknown County", state: "" };
  const record = {
    request_id: `AGR-SRV-${counter}`,
    status: "REQUEST_RECEIVED",
    equipment, brand: brand || "", issue, zip_code: zip,
    county: loc.county, state: loc.state,
    preferred_day: preferred_day || "any time",
    phone_number,
    service_type: /won.?t start|broke|not working|leak|stuck|dead/i.test(issue) ? "urgent_repair" : "repair",
    created_ms: now,
    updated_at: new Date(now).toISOString(),
  };
  requests.set(record.request_id, record);
  console.log("[new request]", record.request_id, record.equipment, "-", record.issue, `(${zip})`);
  res.status(201).json({ request_id: record.request_id, status: record.status, message: statusMessage(record) });
});

app.get("/service-requests/:id", (req, res) => {
  const r = findRequest(req, res);
  if (r) res.json(publicView(r));
});

app.post("/service-requests/:id/cancel", (req, res) => {
  const r = findRequest(req, res);
  if (!r) return;
  if (r.status === "COMPLETED" || r.status === "CANCELLED") {
    return res.status(409).json({ request_id: r.request_id, status: r.status,
      message: `This request is already ${r.status.toLowerCase()} and can't be cancelled.` });
  }
  r.status = "CANCELLED";
  r.updated_at = new Date().toISOString();
  res.json({ request_id: r.request_id, status: r.status, message: `Request ${r.request_id} is cancelled.` });
});

// ---------- workflow endpoints ----------
app.get("/mechanics", (req, res) => {
  const zip = String(req.query.zip || "");
  const list = MECHANICS.filter((m) => m.zips.includes(zip));
  res.json({ zip, count: list.length, available: list.filter((m) => m.available), all: list });
});

app.post("/service-requests/:id/status", (req, res) => {
  const r = findRequest(req, res);
  if (!r) return;
  const { status } = req.body || {};
  if (!STATUS_TEXT[status]) return res.status(400).json({ error: "invalid_status", allowed: Object.keys(STATUS_TEXT) });
  r.status = status;
  r.updated_at = new Date().toISOString();
  res.json(publicView(r));
});

app.post("/bookings", (req, res) => {
  const id = normalizeId(req.body?.request_id);
  const r = id && requests.get(id);
  if (!r) return res.status(404).json({ error: "request_not_found" });
  if (r.status === "CANCELLED") return res.status(409).json({ error: "request_cancelled" });

  // Idempotent: one booking per request
  if (bookings.has(id)) return res.json({ ...bookings.get(id), duplicate: true });

  const m = MECHANICS.find((x) => x.mechanic_id === req.body?.mechanic_id);
  if (!m) return res.status(400).json({ error: "unknown_mechanic" });

  const booking = {
    booking_id: `BOOK-${5000 + bookings.size + 1}`,
    request_id: id,
    mechanic_id: m.mechanic_id,
    mechanic_name: m.name,
    slot: req.body?.slot || m.next_slot,
    status: "CONFIRMED",
  };
  bookings.set(id, booking);
  r.booking = booking;
  r.status = "CONFIRMED";
  r.updated_at = new Date().toISOString();
  res.status(201).json(booking);
});

app.post("/notify", (req, res) => {
  const { phone_number, message } = req.body || {};
  console.log(`[mock SMS] to ${phone_number}: ${message}`);
  res.json({ sent: true, channel: "sms_mock" });
});


// ---------- equipment catalog (cards in chat) ----------
// GET /equipment?type=tractor|truck|combine|sprayer|atv&max_price=60000
// Photos: paste a direct image link in "image" (easiest), OR put a file named like "photo" (e.g. ford-f250.jpg) in mock-api/public/images/.
const EQUIPMENT = [
  { id: "EQ-1", type: "tractor", name: "John Deere 5075E", price: 38500, hp: 75, use: "Mid-size farms, mowing and hauling",
    photo: "john-deere-5075e",
    image: "https://commons.wikimedia.org/wiki/Special:FilePath/Maimarkt_Mannheim_2015_-_John_Deere_5075E.JPG?width=500" },
  { id: "EQ-2", type: "tractor", name: "Kubota Loader Tractor", price: 52900, hp: 70, use: "Row crops and loader work",
    photo: "kubota-m7060",
    image: "https://commons.wikimedia.org/wiki/Special:FilePath/Kubota_tractor_with_front_loader_and_backhoe.jpg?width=500" },
  { id: "EQ-3", type: "truck", name: "Ford F-250 Super Duty", price: 46800, hp: 385, use: "Hauling feed, trailers and tools",
    photo: "ford-f250",
    image: "https://commons.wikimedia.org/wiki/Special:FilePath/Ford_F-250_Crew_Cab_P558_Super_Duty_PowerStroke.jpg?width=500" },
  { id: "EQ-4", type: "truck", name: "Dodge Ram 2500 Heavy Duty", price: 49200, hp: 370, use: "Heavy loads and rough farm roads",
    photo: "ram-2500",
    image: "https://commons.wikimedia.org/wiki/Special:FilePath/Dodge_Ram_2500_Heavy_Duty.jpg?width=500" },
  { id: "EQ-5", type: "combine", name: "Case IH AFX8010 Combine", price: 410000, hp: 330, use: "Harvesting corn and soybeans",
    photo: "case-ih-axial-flow",
    image: "https://commons.wikimedia.org/wiki/Special:FilePath/Case_IH_AFX8010_combine_harvester_1.jpg?width=500" },
  { id: "EQ-6", type: "sprayer", name: "John Deere 4630 Sprayer", price: 285000, hp: 300, use: "Crop spraying across large fields",
    photo: "john-deere-sprayer",
    image: "https://commons.wikimedia.org/wiki/Special:FilePath/John_Deere_4630_Self-Propelled_Sprayer_(16269461688).jpg?width=500" },
  { id: "EQ-7", type: "atv", name: "Polaris Ranger XP 700", price: 17999, hp: 82, use: "Fast field checks and fence work",
    photo: "polaris-ranger",
    image: "https://commons.wikimedia.org/wiki/Special:FilePath/Polaris_Ranger_XP_700.jpg?width=500" },
];

app.get("/equipment", (req, res) => {
  const type = String(req.query.type || "").toLowerCase();
  const max = Number(req.query.max_price) || Infinity;
  const list = EQUIPMENT.filter((e) => (!type || type === "any" || e.type === type) && e.price <= max);
  const money = (n) => "$" + n.toLocaleString("en-US");
  const base = `${req.protocol}://${req.get("host")}`;
  const photoUrl = (name) => {
    for (const ext of ["jpg", "jpeg", "png", "webp"]) {
      if (fs.existsSync(path.join(IMG_DIR, `${name}.${ext}`))) return `${base}/images/${name}.${ext}`;
    }
    return undefined; // no file yet: the card shows without a photo
  };
  // "items" are already in card shape, so the agent can show them as a carousel.
  res.json({
    count: list.length,
    summary: list.length
      ? `I found ${list.length} ${type && type !== "any" ? type : "equipment"} option${list.length > 1 ? "s" : ""}, from ${money(Math.min(...list.map((e) => e.price)))} to ${money(Math.max(...list.map((e) => e.price)))}.`
      : "I couldn't find equipment matching that. Try a different type or budget.",
    items: list.map((e) => ({
      id: e.id,
      title: e.name,
      subtitle: `${money(e.price)} - ${e.hp} HP - ${e.use}`,
      image: e.image || photoUrl(e.photo),
    })),
  });
});

app.get("/health", (_req, res) => res.json({ ok: true, requests: requests.size }));

// View all stored data in browser
app.get("/debug", (_req, res) => {
  const allRequests = Object.fromEntries(requests);
  res.json({ total: requests.size, serviceRequests: allRequests, bookings });
});

app.listen(PORT, () => console.log(`AgriSense mock API on port ${PORT}`));
