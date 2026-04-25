const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin
try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        serviceAccount = require("./serviceAccountKey.json");
    }
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Firebase Admin initialized");
} catch (e) {
    console.error("⚠️ Firebase Admin initialization failed (missing serviceAccount file or env variable). Push notifications disabled.", e.message);
}

// Configuration management
const CONFIG_PATH = path.join(__dirname, "config.json");
let CONFIG = {};

// Load configuration from file
function loadConfig() {
    try {
        const configData = fs.readFileSync(CONFIG_PATH, "utf8");
        CONFIG = JSON.parse(configData);
        console.log("✅ Configuration loaded successfully");
        return CONFIG;
    } catch (err) {
        console.error("❌ Error loading config.json:", err.message);
        console.log("⚠️ Using default configuration");
        // Return default config if file doesn't exist
        CONFIG = getDefaultConfig();
        return CONFIG;
    }
}

// Save configuration to file
function saveConfig(newConfig) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), "utf8");
        CONFIG = newConfig;
        console.log("✅ Configuration saved successfully");
        return true;
    } catch (err) {
        console.error("❌ Error saving config.json:", err.message);
        return false;
    }
}

// Get default configuration
function getDefaultConfig() {
    return {
        thresholds: {
            temperature: {
                idealMin: 4, idealMax: 8, warningMin: 3, warningMax: 12,
                criticalMin: 2, criticalMax: 15, unit: "°C"
            },
            humidity: {
                idealMin: 90, idealMax: 95, warningMin: 85, warningMax: 98,
                criticalMin: 80, criticalMax: 100, unit: "%"
            },
            airQuality: {
                good: 150, moderate: 300, poor: 500, veryPoor: 600, unit: "MQ135"
            },
            spoilageRisk: {
                low: 20, medium: 40, high: 70, critical: 85, unit: "%"
            },
            condensation: { dewPointDifference: 2, unit: "°C" }
        },
        alerts: {
            buzzerEnabled: false,
            buzzerDuration: 1000,
            criticalRiskThreshold: 70,
            muteAfterAcknowledge: false,
            soundPattern: "pulsing"
        },
        dataCollection: {
            sampleInterval: 30000,
            autoRefreshInterval: 5000,
            dataRetentionDays: 30,
            historySize: 10,
            unit: "milliseconds"
        },
        analytics: {
            trendDetection: {
                risingRapidlyThreshold: 1,
                risingThreshold: 0.3,
                fallingRapidlyThreshold: -1,
                fallingThreshold: -0.3,
                minimumDataPoints: 3
            },
            predictions: {
                minimumDataPoints: 5,
                confidenceThresholds: {
                    high: 70, medium: 40, low: 0
                },
                timeToCriticalEnabled: true
            },
            patterns: {
                spikeThreshold: 0.15,
                accelerationMultiplier: 1.5
            }
        },
        display: {
            chartMaxPoints: 50,
            chartTimeRange: 24,
            showAdvancedMetrics: false,
            temperatureUnit: "celsius"
        },
        system: {
            apiKey: "demo123",
            port: 3000,
            allowRemoteAccess: true
        }
    };
}

// Load config on startup
loadConfig();

// Helper to get THRESHOLDS (for backward compatibility)
const THRESHOLDS = CONFIG.thresholds || getDefaultConfig().thresholds;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Database setup
const db = new sqlite3.Database("silo_data.db", (err) => {
    if (err) console.error("❌ DB error:", err.message);
    else console.log("✅ Connected to SQLite database");
});

// Create database tables
db.run(`CREATE TABLE IF NOT EXISTS sensor_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deviceId TEXT,
  temperature REAL,
  humidity REAL,
  mq_value REAL,
  spoilageRisk REAL,
  grainHealth TEXT,
  dewPoint REAL,
  absoluteHumidity REAL,
  vaporPressureDeficit REAL,
  equilibriumMoistureContent REAL,
  trendAnalysis TEXT,
  prediction TEXT,
  rssi INTEGER,
  ip TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`, (err) => {
    if (err) console.error("❌ Table error:", err.message);
    else console.log("✅ Enhanced sensor table ready");
});

db.run(`CREATE TABLE IF NOT EXISTS fcm_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE,
  farmer_id INTEGER,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`, (err) => {
    if (err) console.error("❌ Token table error:", err.message);
    else {
        console.log("✅ FCM token table ready");
        db.run("ALTER TABLE fcm_tokens ADD COLUMN farmer_id INTEGER", () => { });
    }
});

// Multi-farmer tables
db.run(`CREATE TABLE IF NOT EXISTS farmers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pin TEXT NOT NULL,
  role TEXT DEFAULT 'farmer',
  reference_code TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`, async (err) => {
    if (err) { console.error("❌ Farmers table error:", err.message); return; }
    console.log("✅ Farmers table ready");

    // Migration: add reference_code column if not exists (safe — table is confirmed to exist here)
    db.run("ALTER TABLE farmers ADD COLUMN reference_code TEXT", (mErr) => {
        if (mErr && !mErr.message.includes('duplicate column')) {
            console.error("❌ Migration error:", mErr.message);
        } else {
            // Backfill existing farmers missing a reference code
            db.all("SELECT id FROM farmers WHERE reference_code IS NULL", (e, rows) => {
                if (!e && rows && rows.length) {
                    rows.forEach(row => {
                        const code = String(Math.floor(100000 + Math.random() * 900000));
                        db.run("UPDATE farmers SET reference_code = ? WHERE id = ? AND reference_code IS NULL", [code, row.id]);
                    });
                    console.log(`✅ Backfilled ${rows.length} farmer reference code(s)`);
                }
            });
        }
    });

    // Seed default admin if table is empty
    db.get("SELECT COUNT(*) as cnt FROM farmers", async (e2, row) => {
        if (!e2 && row.cnt === 0) {
            const hashedPin = await bcrypt.hash("0000", 10);
            const refCode = await generateRefCode();
            db.run("INSERT INTO farmers (username, pin, role, reference_code) VALUES (?, ?, ?, ?)",
                ["admin", hashedPin, "admin", refCode],
                () => console.log(`✅ Default admin created (pin: 0000, ref: ${refCode})`));
        }
    });
});

db.run(`CREATE TABLE IF NOT EXISTS node_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deviceId TEXT NOT NULL,
  farmer_id INTEGER NOT NULL,
  assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(deviceId, farmer_id)
)`, (err) => {
    if (err) console.error("❌ Node assignments table error:", err.message);
    else console.log("✅ Node assignments table ready");
});

db.run(`CREATE TABLE IF NOT EXISTS farmer_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farmer_id INTEGER UNIQUE NOT NULL,
  config TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`, (err) => {
    if (err) console.error("❌ farmer_configs table error:", err.message);
    else console.log("✅ Farmer configs table ready");
});

// Create indexes
db.run("CREATE INDEX IF NOT EXISTS idx_deviceId ON sensor_data(deviceId)", (err) => {
    if (err) console.error("Index error:", err.message);
});

db.run("CREATE INDEX IF NOT EXISTS idx_timestamp ON sensor_data(timestamp)", (err) => {
    if (err) console.error("Index error:", err.message);
});

// API key middleware
const apiKeyMiddleware = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== "demo123") {
        return res.status(401).json({ error: "Invalid API key" });
    }
    next();
};

// Farmer auth middleware
const farmerMiddleware = (req, res, next) => {
    const farmerId = req.headers['x-farmer-id'];
    if (!farmerId) return res.status(401).json({ error: "Not authenticated" });
    db.get("SELECT * FROM farmers WHERE id = ?", [farmerId], (err, row) => {
        if (err || !row) return res.status(401).json({ error: "Invalid session" });
        req.farmer = row;
        next();
    });
};

// Admin-only middleware
const adminMiddleware = (req, res, next) => {
    const farmerId = req.headers['x-farmer-id'];
    if (!farmerId) return res.status(401).json({ error: "Not authenticated" });
    db.get("SELECT * FROM farmers WHERE id = ? AND role = 'admin'", [farmerId], (err, row) => {
        if (err || !row) return res.status(403).json({ error: "Admin access required" });
        req.farmer = row;
        next();
    });
};

// Helper: get farmer's personal configuration (merged with global defaults)
async function getFarmerConfig(farmerId) {
    return new Promise((resolve) => {
        if (!farmerId) return resolve(CONFIG);
        db.get("SELECT config FROM farmer_configs WHERE farmer_id = ?", [farmerId], (err, row) => {
            if (err || !row) return resolve(CONFIG);
            try {
                const farmerSpecific = JSON.parse(row.config);
                // Merge farmer settings into base CONFIG
                const merged = deepMerge(CONFIG, farmerSpecific);
                resolve(merged);
            } catch (e) {
                resolve(CONFIG);
            }
        });
    });
}

// Helper: get deviceIds assigned to a farmer
function getFarmerDeviceIds(farmerId, callback) {
    db.get("SELECT role FROM farmers WHERE id = ?", [farmerId], (err, farmer) => {
        if (err || !farmer) return callback(err || new Error('Not found'), []);
        if (farmer.role === 'admin') {
            db.all("SELECT DISTINCT deviceId FROM sensor_data", (err2, rows) => {
                callback(err2, rows ? rows.map(r => r.deviceId) : []);
            });
        } else {
            db.all("SELECT deviceId FROM node_assignments WHERE farmer_id = ?", [farmerId], (err2, rows) => {
                callback(err2, rows ? rows.map(r => r.deviceId) : []);
            });
        }
    });
}

// Helper to send FCM notifications
function sendFcmNotification(title, body, targetDeviceId = null) {
    if (!admin.apps.length) return;

    const executeSend = (tokens) => {
        if (!tokens || tokens.length === 0) return;
        const message = { notification: { title, body }, tokens };
        admin.messaging().sendEachForMulticast(message)
            .then(res => console.log(`✅ Push sent: ${res.successCount} success, ${res.failureCount} failed`))
            .catch(e => console.error("❌ Push error:", e));
    };

    if (targetDeviceId) {
        db.get("SELECT farmer_id FROM node_assignments WHERE deviceId = ?", [targetDeviceId], (err, row) => {
            if (!err && row && row.farmer_id) {
                db.all("SELECT token FROM fcm_tokens WHERE farmer_id = ?", [row.farmer_id], (e, rows) => {
                    if (!e && rows) executeSend(rows.map(r => r.token));
                });
            } else {
                console.log(`⚠️ FCM skipped: Node ${targetDeviceId} is not assigned to any farmer.`);
            }
        });
    } else {
        db.all("SELECT token FROM fcm_tokens", (err, rows) => {
            if (!err && rows) executeSend(rows.map(r => r.token));
        });
    }
}

// ==========================================
// AUTH & FARMER ROUTES
// ==========================================

// Generate a unique 6-digit reference code
async function generateRefCode() {
    return new Promise((resolve, reject) => {
        const tryCode = () => {
            const code = String(Math.floor(100000 + Math.random() * 900000));
            db.get("SELECT id FROM farmers WHERE reference_code = ?", [code], (err, row) => {
                if (err) return reject(err);
                if (row) return tryCode(); // collision, retry
                resolve(code);
            });
        };
        tryCode();
    });
}

// POST /api/auth/register — public: register a new farmer
app.post("/api/auth/register", async (req, res) => {
    const { username, pin } = req.body;
    if (!username || !pin || pin.length !== 4) return res.status(400).json({ error: "Username and 4-digit PIN required" });
    try {
        const hashedPin = await bcrypt.hash(pin.trim(), 10);
        const refCode = await generateRefCode();
        db.run("INSERT INTO farmers (username, pin, role, reference_code) VALUES (?, ?, 'farmer', ?)",
            [username.trim(), hashedPin, refCode],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: "Username already exists" });
                    return res.status(500).json({ error: "Database error" });
                }
                res.json({ success: true, id: this.lastID, username: username.trim(), role: 'farmer', reference_code: refCode });
            }
        );
    } catch (e) {
        res.status(500).json({ error: "Error creating account" });
    }
});

// POST /api/auth/login
app.post("/api/auth/login", (req, res) => {
    const { username, pin } = req.body;
    if (!username || !pin) return res.status(400).json({ error: "Username and PIN required" });

    db.get("SELECT * FROM farmers WHERE username = ?", [username.trim()], async (err, row) => {
        if (err || !row) return res.status(401).json({ error: "Invalid username or PIN" });

        const isMatch = await bcrypt.compare(pin.trim(), row.pin);
        if (!isMatch) return res.status(401).json({ error: "Invalid username or PIN" });

        res.json({ success: true, farmerId: row.id, username: row.username, role: row.role, reference_code: row.reference_code });
    });
});

// GET /api/farmers — admin only
app.get("/api/farmers", adminMiddleware, (req, res) => {
    db.all("SELECT id, username, role, created_at FROM farmers ORDER BY id ASC", (err, rows) => {
        if (err) return res.status(500).json({ error: "DB error" });
        res.json(rows || []);
    });
});

// POST /api/farmers — admin only: create farmer
app.post("/api/farmers", adminMiddleware, async (req, res) => {
    const { username, pin, role } = req.body;
    if (!username || !pin) return res.status(400).json({ error: "Username and PIN required" });
    const safeRole = role === 'admin' ? 'admin' : 'farmer';

    try {
        const hashedPin = await bcrypt.hash(pin.trim(), 10);
        db.run("INSERT INTO farmers (username, pin, role) VALUES (?, ?, ?)",
            [username.trim(), hashedPin, safeRole],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: "Username already exists" });
                    return res.status(500).json({ error: "DB error" });
                }
                res.json({ success: true, id: this.lastID, username: username.trim(), role: safeRole });
            }
        );
    } catch (e) {
        res.status(500).json({ error: "Encryption error" });
    }
});

// DELETE /api/farmers/:id — admin only
app.delete("/api/farmers/:id", adminMiddleware, (req, res) => {
    const { id } = req.params;
    if (parseInt(id) === req.farmer.id) return res.status(400).json({ error: "Cannot delete yourself" });
    db.run("DELETE FROM node_assignments WHERE farmer_id = ?", [id], () => {
        db.run("DELETE FROM farmers WHERE id = ?", [id], function (err) {
            if (err) return res.status(500).json({ error: "DB error" });
            res.json({ success: true });
        });
    });
});

// GET /api/nodes/assignments — admin: all assignments
app.get("/api/nodes/assignments", adminMiddleware, (req, res) => {
    const q = `
        SELECT na.id, na.deviceId, na.farmer_id, f.username, na.assigned_at
        FROM node_assignments na
        JOIN farmers f ON f.id = na.farmer_id
        ORDER BY na.farmer_id, na.deviceId
    `;
    db.all(q, (err, rows) => {
        if (err) return res.status(500).json({ error: "DB error" });
        res.json(rows || []);
    });
});

// POST /api/nodes/assign — admin: assign node to farmer
app.post("/api/nodes/assign", adminMiddleware, (req, res) => {
    const { deviceId, farmer_id } = req.body;
    if (!deviceId || !farmer_id) return res.status(400).json({ error: "deviceId and farmer_id required" });
    db.run("INSERT OR IGNORE INTO node_assignments (deviceId, farmer_id) VALUES (?, ?)",
        [deviceId, farmer_id],
        function (err) {
            if (err) return res.status(500).json({ error: "DB error" });
            res.json({ success: true, assigned: this.changes > 0 });
        }
    );
});

// DELETE /api/nodes/assign — admin: remove assignment
app.delete("/api/nodes/assign", adminMiddleware, (req, res) => {
    const { deviceId, farmer_id } = req.body;
    db.run("DELETE FROM node_assignments WHERE deviceId = ? AND farmer_id = ?",
        [deviceId, farmer_id],
        function (err) {
            if (err) return res.status(500).json({ error: "DB error" });
            res.json({ success: true });
        }
    );
});

// DELETE /api/nodes/:deviceId — farmer deletes their own node (or admin any node)
app.delete("/api/nodes/:deviceId", farmerMiddleware, (req, res) => {
    const { deviceId } = req.params;
    const farmer = req.farmer;
    const doDelete = () => {
        db.run("DELETE FROM node_assignments WHERE deviceId = ?", [deviceId], () => {
            db.run("DELETE FROM sensor_data WHERE deviceId = ?", [deviceId], function (err) {
                if (err) return res.status(500).json({ error: "DB error" });
                console.log(`🗑️ Node ${deviceId} deleted by ${farmer.username}`);
                res.json({ success: true, deleted: this.changes });
            });
        });
    };
    if (farmer.role === 'admin') {
        doDelete();
    } else {
        db.get("SELECT * FROM node_assignments WHERE deviceId = ? AND farmer_id = ?",
            [deviceId, farmer.id], (err, row) => {
                if (err || !row) return res.status(403).json({ error: "Not your node" });
                doDelete();
            });
    }
});

// GET /api/nodes/unassigned — admin: nodes with no assignment
app.get("/api/nodes/unassigned", adminMiddleware, (req, res) => {
    const q = `
        SELECT DISTINCT deviceId FROM sensor_data
        WHERE deviceId NOT IN (SELECT DISTINCT deviceId FROM node_assignments)
        ORDER BY deviceId
    `;
    db.all(q, (err, rows) => {
        if (err) return res.status(500).json({ error: "DB error" });
        res.json(rows ? rows.map(r => r.deviceId) : []);
    });
});

// ==========================================
// NODE API ROUTES
// ==========================================

// GET all data (for history page)
app.get("/api/data", (req, res) => {
    const { deviceId, limit = 1000 } = req.query;
    const farmerId = req.headers['x-farmer-id'];

    const runQuery = (deviceFilter) => {
        let query = "SELECT * FROM sensor_data";
        let params = [];

        if (deviceId) {
            if (deviceFilter.length > 0 && !deviceFilter.includes(deviceId)) {
                return res.json([]); // Requested device doesn't belong to farmer
            }
            query += " WHERE deviceId = ?";
            params.push(deviceId);
        } else if (deviceFilter.length > 0) {
            query += ` WHERE deviceId IN (${deviceFilter.map(() => '?').join(',')})`;
            params.push(...deviceFilter);
        }

        query += " ORDER BY timestamp DESC LIMIT ?";
        params.push(parseInt(limit));

        db.all(query, params, (err, rows) => {
            if (err) {
                console.error("❌ Error fetching data:", err);
                return res.status(500).json({ error: "Database error" });
            }
            res.json(rows);
        });
    };

    if (farmerId) {
        getFarmerDeviceIds(farmerId, (err, ids) => {
            if (err) return res.status(500).json({ error: "DB error" });
            if (ids.length === 0) return res.json([]);
            runQuery(ids);
        });
    } else {
        runQuery([]);
    }
});

// POST data endpoint
app.post("/api/data", apiKeyMiddleware, (req, res) => {
    const {
        deviceId, temperature, humidity, mq_value, spoilageRisk,
        grainHealth, dewPoint, absoluteHumidity, vaporPressureDeficit,
        equilibriumMoistureContent, trendAnalysis, prediction, rssi, ip
    } = req.body;

    console.log(`📥 ${deviceId}: ${temperature}°C, ${humidity}%, Risk: ${spoilageRisk}%`);

    db.run(
        `INSERT INTO sensor_data (
      deviceId, temperature, humidity, mq_value, spoilageRisk, 
      grainHealth, dewPoint, absoluteHumidity, vaporPressureDeficit,
      equilibriumMoistureContent, trendAnalysis, prediction, rssi, ip
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            deviceId || "unknown",
            parseFloat(temperature) || 0,
            parseFloat(humidity) || 0,
            parseFloat(mq_value) || 0,
            parseFloat(spoilageRisk) || 0,
            grainHealth || "UNKNOWN",
            parseFloat(dewPoint) || 0,
            parseFloat(absoluteHumidity) || 0,
            parseFloat(vaporPressureDeficit) || 0,
            parseFloat(equilibriumMoistureContent) || 0,
            trendAnalysis || "INSUFFICIENT_DATA",
            prediction || "NEED_MORE_DATA",
            parseInt(rssi) || 0,
            ip || "unknown"
        ],
        function (err) {
            if (err) {
                console.error("❌ DB insert error:", err);
                return res.status(500).json({ error: "Database error" });
            }

            // Get farmer for this device to check their specific thresholds for FCM
            db.get("SELECT farmer_id FROM node_assignments WHERE deviceId = ?", [deviceId], async (e_assign, assignment) => {
                const fId = assignment ? assignment.farmer_id : null;
                const fConfig = await getFarmerConfig(fId);
                const thresholds = fConfig.thresholds.spoilageRisk;

                if (parseFloat(spoilageRisk) >= thresholds.high || grainHealth === "CRITICAL") {
                    sendFcmNotification("Critical Spoilage Alert", `Node ${deviceId || 'unknown'} has critical risk: ${parseFloat(spoilageRisk).toFixed(1)}%`, deviceId);
                }
            });

            // Auto-assign node to farmer by parsing REFCODE_ prefix from deviceId
            const prefixMatch = (deviceId || '').match(/^(\d{6})_/);
            if (prefixMatch) {
                const refCode = prefixMatch[1];
                db.get("SELECT id FROM farmers WHERE reference_code = ?", [refCode], (e, farmer) => {
                    if (!e && farmer) {
                        db.run(
                            "INSERT OR IGNORE INTO node_assignments (deviceId, farmer_id) VALUES (?, ?)",
                            [deviceId, farmer.id],
                            (e2) => { if (!e2) console.log(`🔗 Auto-assigned ${deviceId} → farmer ${farmer.id}`); }
                        );
                    }
                });
            }
            res.json({ success: true, id: this.lastID, message: "Data received successfully" });
        }
    );
});

// Register FCM Token
app.post("/api/fcm-token", (req, res) => {
    const { token } = req.body;
    const farmerId = req.headers['x-farmer-id'] || null;

    if (!token) return res.status(400).json({ error: "Token required" });

    db.run(
        `INSERT INTO fcm_tokens (token, farmer_id) VALUES (?, ?)
         ON CONFLICT(token) DO UPDATE SET farmer_id = excluded.farmer_id`,
        [token, farmerId],
        function (err) {
            if (err) {
                console.error("❌ FCM DB error:", err);
                return res.status(500).json({ error: "Database error" });
            }
            res.json({ success: true, message: "Token registered" });
        }
    );
});

app.get("/api/fcm-health", (req, res) => {
    db.all("SELECT * FROM fcm_tokens", (err, rows) => {
        res.json({
            firebase_initialized: admin.apps.length > 0,
            has_env_var: !!process.env.FIREBASE_SERVICE_ACCOUNT,
            registered_tokens_count: rows ? rows.length : 0,
            tokens: rows ? rows.map(r => r.token.substring(0, 5) + "...") : []
        });
    });
});

// Get latest readings from all devices (filtered by farmer if x-farmer-id provided)
app.get("/api/latest", (req, res) => {
    const farmerId = req.headers['x-farmer-id'];
    const runQuery = (deviceFilter) => {
        const hasFilter = deviceFilter && deviceFilter.length > 0;
        const query = `
          SELECT s1.*
          FROM sensor_data s1
          INNER JOIN (
            SELECT deviceId, MAX(timestamp) as latest
            FROM sensor_data
            ${hasFilter ? `WHERE deviceId IN (${deviceFilter.map(() => '?').join(',')})` : ''}
            GROUP BY deviceId
          ) s2 ON s1.deviceId = s2.deviceId AND s1.timestamp = s2.latest
          ${hasFilter ? `WHERE s1.deviceId IN (${deviceFilter.map(() => '?').join(',')})` : ''}
          ORDER BY s1.deviceId
        `;
        // Pass deviceFilter twice if filter is present
        const params = hasFilter ? [...deviceFilter, ...deviceFilter] : [];

        db.all(query, params, (err, rows) => {
            if (err) {
                console.error("❌ DB read error in /api/latest:", err);
                return res.status(500).json({ error: "Database error", details: err.message });
            }
            res.json(rows || []);
        });
    };
    if (farmerId) {
        getFarmerDeviceIds(farmerId, (err, ids) => {
            if (err) return res.status(500).json({ error: "DB error" });
            if (ids.length === 0) return res.json([]);
            runQuery(ids);
        });
    } else {
        runQuery([]);
    }
});


// Configuration API Endpoints
// GET current configuration (farmer-scoped if x-farmer-id header present)
app.get("/api/config", (req, res) => {
    const farmerId = req.headers['x-farmer-id'];
    if (farmerId) {
        db.get("SELECT config FROM farmer_configs WHERE farmer_id = ?", [farmerId], (err, row) => {
            if (!err && row) {
                try { return res.json(JSON.parse(row.config)); } catch (e) { }
            }
            res.json(CONFIG); // fall back to global
        });
    } else {
        res.json(CONFIG);
    }
});

// PUT update configuration (farmer-scoped if x-farmer-id header present, else global)
app.put("/api/config", (req, res) => {
    const farmerId = req.headers['x-farmer-id'];
    try {
        const updates = req.body;
        if (farmerId) {
            // Per-farmer config: load existing, deep-merge, save to farmer_configs
            db.get("SELECT config FROM farmer_configs WHERE farmer_id = ?", [farmerId], (err, row) => {
                const base = (row && !err) ? (() => { try { return JSON.parse(row.config); } catch (e) { return CONFIG; } })() : CONFIG;
                const merged = deepMerge(base, updates);
                const json = JSON.stringify(merged);
                db.run(
                    `INSERT INTO farmer_configs (farmer_id, config) VALUES (?, ?)
                     ON CONFLICT(farmer_id) DO UPDATE SET config = excluded.config, updated_at = CURRENT_TIMESTAMP`,
                    [farmerId, json],
                    (e2) => {
                        if (e2) return res.status(500).json({ error: "Failed to save config" });
                        res.json({ success: true, message: "Thresholds saved", config: merged });
                    }
                );
            });
        } else {
            // Global config (admin/legacy)
            const updatedConfig = deepMerge(CONFIG, updates);
            const validation = validateConfig(updatedConfig);
            if (!validation.valid) return res.status(400).json({ error: "Invalid configuration", details: validation.errors });
            if (saveConfig(updatedConfig)) {
                Object.assign(THRESHOLDS, updatedConfig.thresholds);
                res.json({ success: true, message: "Configuration updated successfully", config: updatedConfig });
            } else {
                res.status(500).json({ error: "Failed to save configuration" });
            }
        }
    } catch (err) {
        console.error("❌ Config update error:", err);
        res.status(500).json({ error: "Internal server error", message: err.message });
    }
});

// POST reset configuration to defaults
app.post("/api/config/reset", (req, res) => {
    try {
        const defaultConfig = getDefaultConfig();

        if (saveConfig(defaultConfig)) {
            // Update THRESHOLDS reference
            Object.assign(THRESHOLDS, defaultConfig.thresholds);

            res.json({
                success: true,
                message: "Configuration reset to defaults",
                config: defaultConfig
            });
        } else {
            res.status(500).json({
                error: "Failed to reset configuration"
            });
        }
    } catch (err) {
        console.error("❌ Config reset error:", err);
        res.status(500).json({
            error: "Internal server error",
            message: err.message
        });
    }
});

// Helper function: Deep merge objects
function deepMerge(target, source) {
    const output = Object.assign({}, target);

    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            if (isObject(source[key])) {
                if (!(key in target)) {
                    Object.assign(output, { [key]: source[key] });
                } else {
                    output[key] = deepMerge(target[key], source[key]);
                }
            } else {
                Object.assign(output, { [key]: source[key] });
            }
        });
    }

    return output;
}

function isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
}

// Helper function: Validate configuration
function validateConfig(config) {
    const errors = [];

    // Validate thresholds
    if (config.thresholds) {
        const t = config.thresholds;

        // Temperature validation
        if (t.temperature) {
            if (t.temperature.idealMin >= t.temperature.idealMax) {
                errors.push("Temperature idealMin must be less than idealMax");
            }
            if (t.temperature.criticalMin >= t.temperature.criticalMax) {
                errors.push("Temperature criticalMin must be less than criticalMax");
            }
        }

        // Humidity validation
        if (t.humidity) {
            if (t.humidity.idealMin >= t.humidity.idealMax) {
                errors.push("Humidity idealMin must be less than idealMax");
            }
            if (t.humidity.idealMin < 0 || t.humidity.idealMax > 100) {
                errors.push("Humidity values must be between 0 and 100");
            }
        }

        // Spoilage risk validation
        if (t.spoilageRisk) {
            if (t.spoilageRisk.low >= t.spoilageRisk.medium ||
                t.spoilageRisk.medium >= t.spoilageRisk.high) {
                errors.push("Spoilage risk thresholds must be in ascending order");
            }
        }
    }

    // Validate alerts
    if (config.alerts) {
        if (config.alerts.buzzerDuration && config.alerts.buzzerDuration < 0) {
            errors.push("Buzzer duration must be positive");
        }
        if (config.alerts.criticalRiskThreshold &&
            (config.alerts.criticalRiskThreshold < 0 || config.alerts.criticalRiskThreshold > 100)) {
            errors.push("Critical risk threshold must be between 0 and 100");
        }
    }

    // Validate data collection
    if (config.dataCollection) {
        if (config.dataCollection.sampleInterval && config.dataCollection.sampleInterval < 1000) {
            errors.push("Sample interval must be at least 1000ms");
        }
        if (config.dataCollection.autoRefreshInterval && config.dataCollection.autoRefreshInterval < 1000) {
            errors.push("Auto refresh interval must be at least 1000ms");
        }
        if (config.dataCollection.dataRetentionDays && config.dataCollection.dataRetentionDays < 1) {
            errors.push("Data retention must be at least 1 day");
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}



// Get device list with status
app.get("/api/devices", (req, res) => {
    const farmerId = req.headers['x-farmer-id'];

    const runQuery = (deviceFilter) => {
        const whereClause = deviceFilter.length > 0
            ? `WHERE deviceId IN (${deviceFilter.map(() => '?').join(',')})`
            : '';

        const query = `
        SELECT 
          deviceId,
          MIN(timestamp) as firstSeen,
          MAX(timestamp) as lastSeen,
          COUNT(*) as readingCount,
          CASE 
            WHEN datetime(MAX(timestamp)) >= datetime('now', '-5 minutes') THEN 'online'
            WHEN datetime(MAX(timestamp)) >= datetime('now', '-1 hour') THEN 'recent'
            ELSE 'offline'
          END as status
        FROM sensor_data 
        ${whereClause}
        GROUP BY deviceId
        ORDER BY lastSeen DESC
      `;

        db.all(query, deviceFilter, (err, rows) => {
            if (err) {
                console.error("❌ DB read error:", err);
                return res.status(500).json({ error: "Database error" });
            }
            res.json(rows || []);
        });
    };

    if (farmerId) {
        getFarmerDeviceIds(farmerId, (err, ids) => {
            if (err) return res.status(500).json({ error: "DB error" });
            if (ids.length === 0) return res.json([]);
            runQuery(ids);
        });
    } else {
        runQuery([]);
    }
});

// Get device history (supports hours-based or start/end date range)
app.get("/api/history/:deviceId", (req, res) => {
    const { deviceId } = req.params;
    const { limit = 50, hours = 24, start, end } = req.query;

    const cols = `id, deviceId, temperature, humidity, mq_value, spoilageRisk,
      grainHealth, dewPoint, absoluteHumidity, vaporPressureDeficit,
      equilibriumMoistureContent, trendAnalysis, prediction, rssi, ip,
      timestamp,
      datetime(timestamp, 'localtime') as ts_server,
      strftime('%H:%M', timestamp, 'localtime') as time_display`;

    let query, params;
    if (start && end) {
        query = `SELECT ${cols} FROM sensor_data WHERE deviceId = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC LIMIT ?`;
        params = [deviceId, start, end, parseInt(limit)];
    } else {
        query = `SELECT ${cols} FROM sensor_data WHERE deviceId = ? AND timestamp >= datetime('now', ?) ORDER BY timestamp ASC LIMIT ?`;
        params = [deviceId, `-${hours} hours`, parseInt(limit)];
    }

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error("❌ DB read error:", err);
            return res.status(500).json({ error: "Database error" });
        }
        res.json(rows);
    });
});

//trends endpoint 
app.get("/api/trends/:deviceId", async (req, res) => {
    const { deviceId } = req.params;
    const { hours = 24 } = req.query;
    const farmerId = req.headers['x-farmer-id'];
    const farmerConfig = await getFarmerConfig(farmerId);

    const query = `
    SELECT 
      temperature, humidity, mq_value, spoilageRisk, grainHealth, dewPoint,
      absoluteHumidity, vaporPressureDeficit, equilibriumMoistureContent,
      trendAnalysis, prediction, rssi, ip, timestamp,
      datetime(timestamp, 'localtime') as ts_server,
      strftime('%H:%M', timestamp, 'localtime') as time_display
    FROM sensor_data 
    WHERE deviceId = ? AND timestamp >= datetime('now', ?)
    ORDER BY timestamp ASC
  `;

    db.all(query, [deviceId, `-${hours} hours`], (err, rows) => {
        if (err) {
            console.error("❌ DB read error:", err);
            return res.status(500).json({ error: "Database error" });
        }

        if (rows.length < 3) {
            return res.json({
                message: "Need at least 3 data points for meaningful analysis",
                status: "INSUFFICIENT_DATA"
            });
        }

        try {
            const analytics = generateDashboardAnalytics(rows, farmerConfig);
            res.json(analytics);
        } catch (analyticsError) {
            console.error("❌ Analytics generation error:", analyticsError);
            res.status(500).json({ error: "Failed to generate analytics", details: analyticsError.message });
        }
    });
});


// Get system stats
app.get("/api/stats", (req, res) => {
    const queries = {
        totalReadings: "SELECT COUNT(*) as count FROM sensor_data",
        activeDevices: "SELECT COUNT(DISTINCT deviceId) as count FROM sensor_data WHERE timestamp >= datetime('now', '-5 minutes')",
        latestReading: "SELECT datetime(MAX(timestamp), 'localtime') as latest FROM sensor_data",
        criticalAlerts: "SELECT COUNT(*) as count FROM sensor_data WHERE grainHealth = 'CRITICAL' AND timestamp >= datetime('now', '-1 hour')"
    };

    const results = {};
    let completed = 0;

    Object.keys(queries).forEach(key => {
        db.get(queries[key], (err, row) => {
            results[key] = row;
            completed++;

            if (completed === Object.keys(queries).length) {
                res.json(results);
            }
        });
    });
});

function generateDashboardAnalytics(rows, config = CONFIG) {
    const recentData = rows.slice(-10);
    const latest = recentData[recentData.length - 1];
    const thresholds = config.thresholds;

    // Extract data arrays
    const temps = recentData.map(d => d.temperature);
    const hums = recentData.map(d => d.humidity);
    const risks = recentData.map(d => d.spoilageRisk || 0);
    const mqValues = recentData.map(d => d.mq_value || 0);

    // Calculate trends
    const tempTrend = calculateSimpleTrend(temps);
    const humTrend = calculateSimpleTrend(hums);
    const riskTrend = calculateSimpleTrend(risks);
    const mqTrend = calculateSimpleTrend(mqValues);

    // Calculate rates of change
    const tempChange = temps.length > 1 ? temps[temps.length - 1] - temps[temps.length - 2] : 0;
    const humChange = hums.length > 1 ? hums[hums.length - 1] - hums[hums.length - 2] : 0;
    const riskChange = risks.length > 1 ? risks[risks.length - 1] - risks[risks.length - 2] : 0;
    const mqChange = mqValues.length > 1 ? mqValues[mqValues.length - 1] - mqValues[mqValues.length - 2] : 0;

    // Generate trends with context - MOVE THIS UP so it's available for summary
    const trends = {
        temperature: {
            value: getTrendLabel(tempTrend),
            explanation: getTemperatureTrendExplanation(tempTrend, tempChange, latest.temperature)
        },
        humidity: {
            value: getTrendLabel(humTrend),
            explanation: getHumidityTrendExplanation(humTrend, humChange, latest.humidity)
        },
        spoilageRisk: {
            value: getTrendLabel(riskTrend),
            explanation: getRiskTrendExplanation(riskTrend, riskChange, latest.spoilageRisk)
        },
        airQuality: {
            value: getTrendLabel(mqTrend),
            explanation: getAirQualityExplanation(mqTrend, mqChange, latest.mq_value)
        }
    };

    // Generate predictions with explanations
    const predictedRisk = Math.min(100, Math.max(0, (latest.spoilageRisk || 0) + (riskChange * 6)));
    const timeToCritical = riskChange > 0 ? Math.max(1, Math.round((70 - (latest.spoilageRisk || 0)) / riskChange)) : null;

    // Generate patterns detection with explanations
    const patterns = {
        acceleratingRisk: {
            detected: detectAcceleratingTrend(risks),
            explanation: "Risk is increasing at an accelerating rate"
        },
        temperatureSpike: {
            detected: detectSpike(temps, 0.15),
            explanation: "Sudden temperature increase detected"
        },
        humiditySurge: {
            detected: detectSpike(hums, 0.15),
            explanation: "Sudden humidity increase detected"
        },
        airQualityDecline: {
            detected: mqValues.length > 3 && mqValues[mqValues.length - 1] > 300,
            explanation: "Air quality sensor indicates elevated gas levels"
        }
    };

    // Create changes object for summary
    const changes = {
        temperature: tempChange,
        humidity: humChange,
        spoilageRisk: riskChange,
        mq135: mqChange
    };

    // Now generate summary with trends available
    const summary = generateDetailedSummary(latest, trends, changes, config.thresholds);

    // Generate predictions with reasoning
    const predictions = generatePredictionsWithReasoning(
        latest, predictedRisk, timeToCritical, riskChange, tempChange, humChange, mqChange
    );

    // Generate actionable recommendations with priority
    const recommendations = generatePrioritizedRecommendations(
        latest, trends, patterns, predictedRisk
    );

    // Calculate confidence with factors
    const confidence = calculateConfidenceWithFactors(recentData.length, trends, patterns);

    return {
        summary,
        predictions,
        trends,
        patterns,
        recommendations,
        confidence,
        metrics: {
            current: {
                temperature: latest.temperature,
                humidity: latest.humidity,
                mq135: latest.mq_value,
                spoilageRisk: latest.spoilageRisk,
                dewPoint: latest.dewPoint
            },
            changes: {
                temperature: tempChange,
                humidity: humChange,
                mq135: mqChange,
                spoilageRisk: riskChange
            }
        }
    };
}


// Generate summary
function generateDetailedSummary(latest, trends, changes, thresholds = CONFIG.thresholds) {
    const risk = latest.spoilageRisk || 0;
    const temp = latest.temperature || 0;
    const hum = latest.humidity || 0;
    const mq = latest.mq_value || 0;

    const summaries = [];

    // Risk level summary
    const riskThresholds = thresholds.spoilageRisk;
    if (risk > riskThresholds.high) {
        summaries.push(`🚨 CRITICAL RISK: ${risk.toFixed(1)}% spoilage risk. Immediate action required.`);
    } else if (risk > riskThresholds.medium) {
        summaries.push(`⚠️ ELEVATED RISK: ${risk.toFixed(1)}% spoilage risk. Monitor closely.`);
    } else {
        summaries.push(`✓ ACCEPTABLE RISK: ${risk.toFixed(1)}% spoilage risk. Conditions stable.`);
    }

    // Temperature analysis
    const tempThresholds = thresholds.temperature;
    if (temp > tempThresholds.warningMax) {
        summaries.push(`🌡️ TEMPERATURE TOO HIGH: ${temp.toFixed(1)}°C exceeds ideal range (${tempThresholds.idealMin}-${tempThresholds.idealMax}°C).`);
    } else if (temp < tempThresholds.idealMin) {
        summaries.push(`❄️ TEMPERATURE TOO LOW: ${temp.toFixed(1)}°C below ideal range. Risk of chilling injury.`);
    } else {
        summaries.push(`✓ TEMPERATURE OPTIMAL: ${temp.toFixed(1)}°C within ideal range (${tempThresholds.idealMin}-${tempThresholds.idealMax}°C).`);
    }

    // Humidity analysis
    const humThresholds = thresholds.humidity;
    if (hum < humThresholds.warningMin) {
        summaries.push(`💧 HUMIDITY TOO LOW: ${hum.toFixed(1)}% below ideal range (${humThresholds.idealMin}-${humThresholds.idealMax}%). Risk of weight loss.`);
    } else if (hum > humThresholds.idealMax) {
        summaries.push(`💦 HUMIDITY TOO HIGH: ${hum.toFixed(1)}% above ideal range. Risk of condensation.`);
    } else {
        summaries.push(`✓ HUMIDITY OPTIMAL: ${hum.toFixed(1)}% within ideal range (${humThresholds.idealMin}-${humThresholds.idealMax}%).`);
    }

    // Air quality analysis
    const airQuality = thresholds.airQuality;
    if (mq > airQuality.poor) {
        summaries.push(`☣️ POOR AIR QUALITY: MQ135 reading ${mq.toFixed(0)} indicates elevated gas levels.`);
    }

    // Dew point analysis
    const condensationThreshold = THRESHOLDS.condensation.dewPointDifference;
    if (latest.dewPoint && (temp - latest.dewPoint) < condensationThreshold) {
        summaries.push(`💧 CONDENSATION RISK: Temperature-dew point difference is ${(temp - latest.dewPoint).toFixed(1)}°C (<${condensationThreshold}°C threshold).`);
    }

    // Trend analysis
    const riskTrend = trends.spoilageRisk?.value || 'STABLE';
    if (riskTrend.includes('RISING')) {
        summaries.push(`📈 RISK TRENDING UPWARD: Spoilage risk is ${riskTrend.toLowerCase().replace('_', ' ')}.`);
    }

    return summaries;
}

function getTemperatureTrendExplanation(trend, change, currentTemp) {
    const trendLabel = getTrendLabel(trend);
    let explanation = "";

    if (trendLabel === 'RISING_RAPIDLY') {
        explanation = `Temperature rising rapidly (${change.toFixed(1)}°C/h). `;
    } else if (trendLabel === 'RISING') {
        explanation = `Temperature slowly rising. `;
    } else if (trendLabel === 'FALLING_RAPIDLY') {
        explanation = `Temperature falling rapidly. `;
    } else if (trendLabel === 'FALLING') {
        explanation = `Temperature slowly falling. `;
    } else {
        explanation = `Temperature stable. `;
    }

    // Add potato-specific context
    if (currentTemp > 12) {
        explanation += `Current ${currentTemp.toFixed(1)}°C is ABOVE ideal potato range (4-8°C).`;
    } else if (currentTemp < 4) {
        explanation += `Current ${currentTemp.toFixed(1)}°C is BELOW ideal potato range (4-8°C).`;
    } else {
        explanation += `Current ${currentTemp.toFixed(1)}°C is within ideal potato range (4-8°C).`;
    }

    return explanation;
}

function getHumidityTrendExplanation(trend, change, currentHum) {
    const trendLabel = getTrendLabel(trend);
    let explanation = "";

    if (trendLabel === 'RISING_RAPIDLY') {
        explanation = `Humidity rising rapidly (${change.toFixed(1)}%/h). `;
    } else if (trendLabel === 'RISING') {
        explanation = `Humidity slowly rising. `;
    } else if (trendLabel === 'FALLING_RAPIDLY') {
        explanation = `Humidity falling rapidly. `;
    } else if (trendLabel === 'FALLING') {
        explanation = `Humidity slowly falling. `;
    } else {
        explanation = `Humidity stable. `;
    }

    // Add potato-specific context
    if (currentHum < 85) {
        explanation += `Current ${currentHum.toFixed(1)}% is BELOW ideal potato humidity (90-95%).`;
    } else if (currentHum > 95) {
        explanation += `Current ${currentHum.toFixed(1)}% is ABOVE ideal potato humidity (90-95%).`;
    } else {
        explanation += `Current ${currentHum.toFixed(1)}% is within ideal potato humidity range.`;
    }

    return explanation;
}

function getRiskTrendExplanation(trend, change, currentRisk) {
    const trendLabel = getTrendLabel(trend);
    let explanation = "";

    if (trendLabel === 'RISING_RAPIDLY') {
        explanation = `Risk increasing rapidly (${change.toFixed(1)}%/h). `;
    } else if (trendLabel === 'RISING') {
        explanation = `Risk slowly increasing. `;
    } else if (trendLabel === 'FALLING_RAPIDLY') {
        explanation = `Risk decreasing rapidly. `;
    } else if (trendLabel === 'FALLING') {
        explanation = `Risk slowly decreasing. `;
    } else {
        explanation = `Risk stable. `;
    }

    // Add risk level context
    if (currentRisk > 70) {
        explanation += `Current risk ${currentRisk.toFixed(1)}% is CRITICAL. Immediate action needed.`;
    } else if (currentRisk > 40) {
        explanation += `Current risk ${currentRisk.toFixed(1)}% is ELEVATED. Monitor closely.`;
    } else {
        explanation += `Current risk ${currentRisk.toFixed(1)}% is ACCEPTABLE.`;
    }

    return explanation;
}

function getAirQualityExplanation(trend, change, currentMQ) {
    const trendLabel = getTrendLabel(trend);
    let explanation = "";

    if (trendLabel === 'RISING_RAPIDLY') {
        explanation = `Air quality declining rapidly. `;
    } else if (trendLabel === 'RISING') {
        explanation = `Air quality slowly declining. `;
    } else if (trendLabel === 'FALLING_RAPIDLY') {
        explanation = `Air quality improving rapidly. `;
    } else if (trendLabel === 'FALLING') {
        explanation = `Air quality slowly improving. `;
    } else {
        explanation = `Air quality stable. `;
    }

    // Add MQ135 value context
    if (currentMQ > 500) {
        explanation += `MQ135 reading ${currentMQ.toFixed(0)} indicates VERY POOR air quality.`;
    } else if (currentMQ > 300) {
        explanation += `MQ135 reading ${currentMQ.toFixed(0)} indicates POOR air quality.`;
    } else if (currentMQ > 150) {
        explanation += `MQ135 reading ${currentMQ.toFixed(0)} indicates MODERATE air quality.`;
    } else {
        explanation += `MQ135 reading ${currentMQ.toFixed(0)} indicates GOOD air quality.`;
    }

    return explanation;
}

function generatePredictionsWithReasoning(latest, predictedRisk, timeToCritical, riskChange, tempChange, humChange, mqChange) {
    let reasoning = [];

    // Build reasoning based on changes
    if (riskChange > 0) {
        reasoning.push(`Risk increasing at ${riskChange.toFixed(2)}% per hour`);
    } else if (riskChange < 0) {
        reasoning.push(`Risk decreasing at ${Math.abs(riskChange).toFixed(2)}% per hour`);
    }

    if (tempChange > 0.5) {
        reasoning.push(`Temperature rising (${tempChange.toFixed(1)}°C/h) contributes to risk increase`);
    }

    if (humChange > 2) {
        reasoning.push(`Humidity rising (${humChange.toFixed(1)}%/h) affects moisture content`);
    }

    if (mqChange > 50) {
        reasoning.push(`Air quality declining indicates potential spoilage gases`);
    }

    // Dew point analysis
    if (latest.dewPoint && (latest.temperature - latest.dewPoint) < 2) {
        reasoning.push(`Condensation risk (temp-dew point <2°C) increases spoilage probability`);
    }

    return {
        predictedRisk: predictedRisk.toFixed(1),
        timeToCritical: timeToCritical,
        confidence: calculateConfidenceWithFactors(10, {}, {}).level,
        reasoning: reasoning.length > 0 ? reasoning : ["Conditions relatively stable"],
        factors: {
            temperatureInfluence: Math.abs(tempChange) * 1.5,
            humidityInfluence: Math.abs(humChange) * 0.8,
            airQualityInfluence: mqChange > 200 ? 1.2 : 0.5
        }
    };
}

function generatePrioritizedRecommendations(latest, trends, patterns, predictedRisk) {
    const recommendations = [];
    const risk = latest.spoilageRisk || 0;
    const temp = latest.temperature || 0;
    const hum = latest.humidity || 0;
    const mq = latest.mq_value || 0;

    // Critical alerts (highest priority)
    if (temp < 3) {
        recommendations.push({
            priority: 'CRITICAL',
            message: '🚨 FREEZING TEMPERATURE: Immediate action needed to prevent potato damage!',
            action: 'Increase heating immediately'
        });
    }

    if (risk > 70) {
        recommendations.push({
            priority: 'CRITICAL',
            message: '🚨 CRITICAL SPOILAGE RISK: Immediate intervention required',
            action: 'Check grain condition and adjust environment'
        });
    }

    // High priority warnings
    if (temp > 12) {
        recommendations.push({
            priority: 'HIGH',
            message: '🌡️ Temperature too high for potato storage',
            action: 'Increase cooling/ventilation to reach 4-8°C range'
        });
    }

    if (hum < 85) {
        recommendations.push({
            priority: 'HIGH',
            message: '💧 Humidity too low - risk of weight loss',
            action: 'Increase humidity to 90-95% range'
        });
    }

    if (hum > 95) {
        recommendations.push({
            priority: 'HIGH',
            message: '💦 Humidity very high - condensation risk',
            action: 'Reduce humidity and check for wet spots'
        });
    }

    // Medium priority
    if (latest.dewPoint && (temp - latest.dewPoint) < 2) {
        recommendations.push({
            priority: 'MEDIUM',
            message: '⚠️ Condensation risk detected',
            action: 'Monitor for moisture and improve air circulation'
        });
    }

    if (mq > 300) {
        recommendations.push({
            priority: 'MEDIUM',
            message: '☣️ Poor air quality detected',
            action: 'Increase ventilation to reduce gas levels'
        });
    }

    // Trend-based recommendations
    if (trends.spoilageRisk?.value?.includes('RISING')) {
        recommendations.push({
            priority: 'MEDIUM',
            message: '📈 Spoilage risk is increasing',
            action: 'Monitor closely and prepare to adjust conditions'
        });
    }

    // Low priority / informational
    if (temp >= 4 && temp <= 8 && hum >= 90 && hum <= 95 && risk < 40) {
        recommendations.push({
            priority: 'LOW',
            message: '✅ Conditions optimal for potato storage',
            action: 'Maintain current temperature (4-8°C) and humidity (90-95%)'
        });
    }

    // Sort by priority
    const priorityOrder = { 'CRITICAL': 0, 'HIGH': 1, 'MEDIUM': 2, 'LOW': 3 };
    recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return recommendations;
}

function calculateConfidenceWithFactors(dataPoints, trends, patterns) {
    let score = 0;
    let factors = [];

    // Data volume factor
    if (dataPoints > 20) {
        score += 40;
        factors.push("High data volume (20+ points)");
    } else if (dataPoints > 10) {
        score += 25;
        factors.push("Moderate data volume (10-20 points)");
    } else {
        score += 10;
        factors.push("Low data volume (<10 points)");
    }

    // Trend clarity factor
    const clearTrends = Object.values(trends).filter(t =>
        t.value !== 'STABLE' && t.value !== 'INSUFFICIENT_DATA'
    ).length;

    if (clearTrends >= 2) {
        score += 30;
        factors.push("Clear trends detected");
    } else if (clearTrends >= 1) {
        score += 15;
        factors.push("Some trends detected");
    }

    // Pattern detection factor
    const detectedPatterns = Object.values(patterns).filter(p => p.detected).length;
    if (detectedPatterns > 0) {
        score += 20;
        factors.push("Patterns detected in data");
    }

    // Data consistency factor
    score += 10; // Base consistency
    factors.push("Data appears consistent");

    // Determine confidence level
    let level = 'low';
    if (score >= 70) level = 'high';
    else if (score >= 40) level = 'medium';

    return {
        level,
        score,
        factors
    };
}

function calculateSimpleTrend(data) {
    if (data.length < 2) return 0;

    const firstHalf = data.slice(0, Math.floor(data.length / 2));
    const secondHalf = data.slice(Math.floor(data.length / 2));

    const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

    return avgSecond - avgFirst;
}

function getTrendLabel(trendValue) {
    if (trendValue > 1.0) return 'RISING_RAPIDLY';
    if (trendValue > 0.3) return 'RISING';
    if (trendValue < -1.0) return 'FALLING_RAPIDLY';
    if (trendValue < -0.3) return 'FALLING';
    return 'STABLE';
}

function detectAcceleratingTrend(data) {
    if (data.length < 4) return false;

    const firstHalf = data.slice(0, Math.floor(data.length / 2));
    const secondHalf = data.slice(Math.floor(data.length / 2));

    const firstTrend = calculateSimpleTrend(firstHalf);
    const secondTrend = calculateSimpleTrend(secondHalf);

    return Math.abs(secondTrend) > Math.abs(firstTrend) * 1.5;
}




// Health check
app.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Serve dashboard
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Advanced Silo Monitor Server running at http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔧 API Health: http://localhost:${PORT}/health`);
    console.log(`📈 Advanced Analytics: http://localhost:${PORT}/api/trends/:deviceId`);
});
