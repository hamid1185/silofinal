#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <DNSServer.h>
#include "DHT.h"
#include <ArduinoJson.h>
#include <Preferences.h>

// ==================== PIN CONFIGURATION ====================
const int DHTPIN = 4;
const int DHTTYPE = DHT22;
const int MQ_PIN = 34;
const int LED_PIN = 2;
const int BUZZER_PIN = 25;
const int BUTTON1_PIN = 26;
const int BUTTON2_PIN = 35;

// ==================== CONSTANTS ====================
const char* SERVER_URL ="http://192.168.10.106:3000/api/data"; //"https://silomonitor.onrender.com/api/data";
const char* API_KEY = "demo123";
const char* AP_SSID = "SiloMonitor-Config";
const char* AP_PASS = "configure123";


// Timing constants (fixed)
const unsigned long DEBOUNCE_DELAY = 250;
const unsigned long DOUBLE_PRESS_WINDOW = 500;
const unsigned long CONFIG_FETCH_INTERVAL = 300000; // Fetch config every 5 minutes
const int MAX_HISTORY_SIZE = 20; // Fixed maximum size for static allocation

// Dynamic configuration variables (fetched from server)
int SAMPLE_INTERVAL_MS = 30000;
int ALARM_DURATION = 1000;
int HISTORY_SIZE = 10;

// Temperature thresholds (dynamic)
float TEMP_IDEAL_MIN = 4.0;
float TEMP_IDEAL_MAX = 8.0;
float TEMP_WARNING_MIN = 3.0;
float TEMP_WARNING_MAX = 12.0;
float TEMP_CRITICAL_MIN = 2.0;
float TEMP_CRITICAL_MAX = 15.0;

// Humidity thresholds (dynamic)
float HUM_IDEAL_MIN = 90.0;
float HUM_IDEAL_MAX = 95.0;
float HUM_WARNING_MIN = 85.0;
float HUM_WARNING_MAX = 98.0;
float HUM_CRITICAL_MIN = 80.0;
float HUM_CRITICAL_MAX = 100.0;

// Spoilage risk thresholds (dynamic)
float RISK_LOW = 20.0;
float RISK_MEDIUM = 40.0;
float RISK_HIGH = 70.0;
float RISK_CRITICAL = 85.0;

// Other thresholds (dynamic)
float DEW_POINT_DIFF = 2.0;
float ALARM_TRIGGER_THRESHOLD = 70.0;
float ALARM_STOP_THRESHOLD = 50.0;

// Air quality thresholds (dynamic)
int AIR_QUALITY_GOOD = 150;
int AIR_QUALITY_MODERATE = 300;
int AIR_QUALITY_POOR = 500;
int AIR_QUALITY_CRITICAL = 600;

// ==================== GLOBAL OBJECTS ====================
DHT dht(DHTPIN, DHTTYPE);
WebServer server(80);
DNSServer dnsServer;
Preferences preferences;

// ==================== GLOBAL VARIABLES ====================
String deviceId = "";
String wifiSsid = "";
String wifiPass = "";
String serverUrl = SERVER_URL;
bool isConfigured = false;
unsigned long lastSampleMillis = 0;
unsigned long lastButton1Press = 0;
unsigned long lastButton2Press = 0;
unsigned long lastButton1SinglePress = 0;
bool waitingForSecondPress = false;
bool alarmActive = false;
unsigned long alarmStartTime = 0;
bool buzzerEnabled = true;
unsigned long lastConfigFetch = 0;
bool configFetched = false;

float tempHistory[MAX_HISTORY_SIZE] = {0};
float humHistory[MAX_HISTORY_SIZE] = {0};
int historyIndex = 0;
bool historyFilled = false;

// ==================== SETUP ====================
void setup() {
  Serial.begin(115200);
  Serial.println("\n🌾 Advanced Silo Monitor (Remote Config)");
  
  // Initialize pins
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(BUTTON1_PIN, INPUT_PULLUP);
  pinMode(BUTTON2_PIN, INPUT_PULLUP);
  
  digitalWrite(LED_PIN, HIGH);
  digitalWrite(BUZZER_PIN, LOW);
  
  // Initialize peripherals
  dht.begin();
  preferences.begin("silo-config", false);
  
  // Startup beeps
  beep(100);
  delay(100);
  beep(100);
  
  Serial.println("✅ Loading default settings...");
  Serial.printf("   Default Sample Interval: %d ms\n", SAMPLE_INTERVAL_MS);
  Serial.printf("   Default Alarm Threshold: %.1f%%\n", ALARM_TRIGGER_THRESHOLD);
  Serial.printf("   Default Buzzer Duration: %d ms\n", ALARM_DURATION);
  
  loadConfig();
  
  if (isConfigured) {
    connectToWiFi();
  } else {
    startCaptivePortal();
  }
}

// ==================== MAIN LOOP ====================
void loop() {
  handleButtons();
  handleBuzzer();
  
  if (isConfigured) {
    // Check WiFi connection
    static unsigned long lastWifiCheck = 0;
    if (millis() - lastWifiCheck > 60000) {
      lastWifiCheck = millis();
      if (WiFi.status() != WL_CONNECTED) {
        Serial.println("⚠️ WiFi disconnected, reconnecting...");
        connectToWiFi();
      }
    }
    
    // Fetch configuration periodically
    if (WiFi.status() == WL_CONNECTED) {
      unsigned long now = millis();
      
      // Fetch config on first run or every CONFIG_FETCH_INTERVAL
      if (!configFetched || (now - lastConfigFetch >= CONFIG_FETCH_INTERVAL)) {
        if (fetchConfig()) {
          lastConfigFetch = now;
        }
      }
      
      // Sample and send data using dynamic interval
      if (now - lastSampleMillis >= SAMPLE_INTERVAL_MS) {
        lastSampleMillis = now;
        processSensorData();
      }
    }
  }
  
  if (!isConfigured) {
    dnsServer.processNextRequest();
    server.handleClient();
  }
  
  delay(50);
}

// ==================== CONFIGURATION ====================
void loadConfig() {
  deviceId = preferences.getString("deviceId", "");
  wifiSsid = preferences.getString("wifiSsid", "");
  wifiPass = preferences.getString("wifiPass", "");
  serverUrl = SERVER_URL;
  
  if (deviceId == "") {
    deviceId = "node-" + String(ESP.getEfuseMac() & 0xFFFFFF, HEX);
    preferences.putString("deviceId", deviceId);
  }
  
  isConfigured = (wifiSsid != "" && wifiPass != "");
  
  Serial.printf("📋 Device ID: %s\n", deviceId.c_str());
  Serial.printf("📡 WiFi: %s\n", wifiSsid.c_str());
}

void factoryReset() {
  Serial.println("🔄 Factory reset...");
  preferences.clear();
  beep(200); delay(200); beep(200); delay(200); beep(200);
  Serial.println("✅ Reset complete. Restarting...");
  delay(1000);
  ESP.restart();
}

// ==================== WIFI ====================
void connectToWiFi() {
  Serial.printf("📡 Connecting to: %s\n", wifiSsid.c_str());
  
  WiFi.disconnect(true);
  delay(1000);
  
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 30000) {
    Serial.print(".");
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    delay(500);
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n✅ Connected! IP: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("📶 RSSI: %d dBm\n", WiFi.RSSI());
    digitalWrite(LED_PIN, HIGH);
    beep(300);
    
    // Fetch configuration immediately after connecting
    Serial.println("📥 Fetching initial configuration...");
    if (fetchConfig()) {
      Serial.println("✅ Initial config loaded");
    } else {
      Serial.println("⚠️ Using default config");
    }
    
    sendStartupAnnouncement();
  } else {
    Serial.println("\n❌ Connection failed!");
    beep(100); delay(200); beep(100); delay(200); beep(100);
    isConfigured = false;
    preferences.putString("wifiSsid", "");
    preferences.putString("wifiPass", "");
    startCaptivePortal();
  }
}

// ==================== CAPTIVE PORTAL ====================
void startCaptivePortal() {
  Serial.println("📡 Starting Captive Portal...");
  
  WiFi.softAP(AP_SSID, AP_PASS);
  delay(100);
  
  IPAddress apIP = WiFi.softAPIP();
  dnsServer.start(53, "*", apIP);
  
  server.on("/", handlePortalRoot);
  server.on("/scan", HTTP_GET, handleScan);
  server.on("/save", HTTP_POST, handleSaveConfig);
  server.onNotFound([]() {
    server.sendHeader("Location", "http://" + WiFi.softAPIP().toString());
    server.send(302, "text/plain", "Redirect");
  });
  
  server.begin();
  
  Serial.printf("🔧 Portal: http://%s\n", apIP.toString().c_str());
  Serial.printf("📶 Connect to: %s, Password: %s\n", AP_SSID, AP_PASS);
  
  unsigned long lastBeep = 0;
  while (!isConfigured) {
    dnsServer.processNextRequest();
    server.handleClient();
    digitalWrite(LED_PIN, (millis() / 500) % 2);
    if (millis() - lastBeep > 5000) {
      beep(100);
      lastBeep = millis();
    }
    delay(10);
  }
}

void handlePortalRoot() {
  String html = "<!DOCTYPE html><html><head><title>Silo Setup</title>";
  html += "<meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<style>body{font-family:Arial;margin:40px;background:#f0f0f0}";
  html += ".container{background:white;padding:20px;border-radius:10px;max-width:400px;margin:0 auto}";
  html += "input,button,select{width:100%;padding:10px;margin:5px 0;border-radius:5px;border:1px solid #ddd}";
  html += "button{background:#007cba;color:white;cursor:pointer}</style></head>";
  html += "<body><div class='container'><h2>Silo Setup</h2>";
  html += "<label>WiFi Network:</label><select id='ssid'><option value=''>Select Network</option></select>";
  html += "<button onclick='scanNetworks()'>Scan Networks</button>";
  html += "<label>Password:</label><input type='password' id='pass'>";
  html += "<label>Device ID:</label><input type='text' id='device' value='";
  html += deviceId;
  html += "'><label>Server URL:</label><input type='text' id='server' value='";
  html += String(SERVER_URL);
  html += "'><button onclick='saveConfig()'>Save & Connect</button></div>";
  html += "<script>";
  html += "async function scanNetworks(){";
  html += "try{const r=await fetch('/scan');const n=await r.json();";
  html += "const s=document.getElementById('ssid');s.innerHTML='<option value=\"\">Select Network</option>';";
  html += "n.forEach(x=>{const o=document.createElement('option');o.value=x.ssid;";
  html += "o.textContent=x.ssid+' ('+x.rssi+' dBm)';s.appendChild(o)})}";
  html += "catch(e){alert('Scan failed')}}";
  html += "async function saveConfig(){";
  html += "const c={ssid:document.getElementById('ssid').value,";
  html += "password:document.getElementById('pass').value,";
  html += "deviceId:document.getElementById('device').value,";
  html += "serverUrl:document.getElementById('server').value};";
  html += "if(!c.ssid||!c.password)return alert('Fill all fields');";
  html += "try{await fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},";
  html += "body:JSON.stringify(c)});alert('Saved! Connecting...');";
  html += "setTimeout(()=>location.reload(),2000)}";
  html += "catch(e){alert('Save failed')}}";
  html += "scanNetworks();</script></body></html>";
  
  server.send(200, "text/html", html);
}

void handleScan() {
  DynamicJsonDocument doc(2048);
  JsonArray networks = doc.to<JsonArray>();
  
  int n = WiFi.scanNetworks();
  for (int i = 0; i < n; i++) {
    JsonObject net = networks.createNestedObject();
    net["ssid"] = WiFi.SSID(i);
    net["rssi"] = WiFi.RSSI(i);
  }
  
  String response;
  serializeJson(doc, response);
  server.send(200, "application/json", response);
  WiFi.scanDelete();
}

void handleSaveConfig() {
  if (!server.hasArg("plain")) {
    server.send(400, "application/json", "{\"error\":\"No data\"}");
    return;
  }
  
  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, server.arg("plain"))) {
    server.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }
  
  wifiSsid = doc["ssid"].as<String>();
  wifiPass = doc["password"].as<String>();
  deviceId = doc["deviceId"].as<String>();
  serverUrl = doc["serverUrl"].as<String>();
  
  preferences.putString("wifiSsid", wifiSsid);
  preferences.putString("wifiPass", wifiPass);
  preferences.putString("deviceId", deviceId);
  preferences.putString("serverUrl", serverUrl);
  
  isConfigured = true;
  
  server.send(200, "application/json", "{\"status\":\"success\"}");
  
  Serial.println("✅ Config saved, restarting...");
  delay(2000);
  ESP.restart();
}

// ==================== SENSOR FUNCTIONS ====================
bool readSensors(float &temp, float &hum, float &mq_value) {
  temp = dht.readTemperature();
  hum = dht.readHumidity();
  mq_value = analogRead(MQ_PIN);
  
  if (isnan(temp) || isnan(hum)) {
    Serial.println("❌ Sensor error");
    return false;
  }
  
  updateHistory(temp, hum);
  return true;
}

void updateHistory(float temp, float hum) {
  tempHistory[historyIndex] = temp;
  humHistory[historyIndex] = hum;
  historyIndex = (historyIndex + 1) % HISTORY_SIZE;
  if (historyIndex == 0) historyFilled = true;
}

float calculateSpoilageRisk(float temp, float hum) {
  float risk = 0;
  
  // Temperature risk
  if (temp > TEMP_CRITICAL_MAX) {
    risk += (temp - TEMP_CRITICAL_MAX) * 4.0;
  } else if (temp > TEMP_WARNING_MAX) {
    risk += (temp - TEMP_WARNING_MAX) * 2.0;
  }
  
  if (temp < TEMP_CRITICAL_MIN) {
    risk += (TEMP_CRITICAL_MIN - temp) * 3.0;
  } else if (temp < TEMP_IDEAL_MIN) {
    risk += 10;
  }
  
  // Humidity risk
  if (hum < HUM_WARNING_MIN) {
    risk += (HUM_WARNING_MIN - hum) * 2.0;
  }
  
  if (hum > HUM_CRITICAL_MAX) {
    risk += (hum - HUM_CRITICAL_MAX) * 5.0;
  } else if (hum > HUM_IDEAL_MAX) {
    risk += (hum - HUM_IDEAL_MAX) * 2.0;
  }
  
  // Dew point risk
  float dewPoint = calculateDewPoint(temp, hum);
  if (dewPoint > temp - DEW_POINT_DIFF) {
    risk += 40; // High condensation risk
  }
  
  // Sprouting risk (if temp above ideal range)
  if (temp > TEMP_IDEAL_MAX) {
    risk += (temp - TEMP_IDEAL_MAX) * 1.5;
  }
  
  return min(risk, 100.0f);
}

float calculateDewPoint(float temp, float hum) {
  float a = 17.27;
  float b = 237.7;
  float alpha = ((a * temp) / (b + temp)) + log(hum / 100.0);
  return (b * alpha) / (a - alpha);
}

float calculateAbsoluteHumidity(float temp, float hum) {
  float satVP = 6.112 * exp((17.67 * temp) / (temp + 243.5));
  float vaporP = (hum / 100.0) * satVP;
  return (vaporP * 100) / (0.4615 * (temp + 273.15));
}

float calculateVaporPressureDeficit(float temp, float hum) {
  float satVP = 0.6108 * exp((17.27 * temp) / (temp + 237.3));
  float actualVP = satVP * (hum / 100.0);
  return satVP - actualVP;
}

float calculateEquilibriumMoistureContent(float temp, float hum) {
  return 9.7 - 0.082 * temp + 0.0025 * hum * temp;
}

String determineGrainHealth(float risk) {
  if (risk > RISK_HIGH) return "CRITICAL";
  if (risk > RISK_MEDIUM) return "WARNING";
  if (risk > RISK_LOW) return "CAUTION";
  return "GOOD";
}

String analyzeTrends() {
  if (!historyFilled && historyIndex < 3) return "INSUFFICIENT_DATA";
  
  int dataPoints = historyFilled ? HISTORY_SIZE : historyIndex;
  if (dataPoints < 3) return "NEED_MORE_DATA";
  
  float sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (int i = 0; i < dataPoints; i++) {
    sumX += i;
    sumY += tempHistory[i];
    sumXY += i * tempHistory[i];
    sumX2 += i * i;
  }
  
  float slope = (dataPoints * sumXY - sumX * sumY) / (dataPoints * sumX2 - sumX * sumX);
  
  if (abs(slope) < 0.3) return "STABLE";
  else if (slope > 0.8) return "RISING_RAPIDLY";
  else if (slope > 0.3) return "RISING";
  else if (slope < -0.8) return "FALLING_RAPIDLY";
  else if (slope < -0.3) return "FALLING";
  
  return "STABLE";
}

String generatePredictions() {
  if (!historyFilled && historyIndex < 5) return "NEED_MORE_DATA";
  
  int dataPoints = historyFilled ? HISTORY_SIZE : historyIndex;
  float recentRisks[5];
  int validPoints = min(5, dataPoints);
  
  for (int i = 0; i < validPoints; i++) {
    int idx = (historyIndex - 1 - i + HISTORY_SIZE) % HISTORY_SIZE;
    recentRisks[i] = calculateSpoilageRisk(tempHistory[idx], humHistory[idx]);
  }
  
  float avgRisk = 0, riskChange = 0;
  for (int i = 0; i < validPoints; i++) {
    avgRisk += recentRisks[i];
    if (i > 0) riskChange += (recentRisks[i] - recentRisks[i-1]);
  }
  avgRisk /= validPoints;
  if (validPoints > 1) riskChange /= (validPoints - 1);
  
  if (riskChange > 2.0) {
    float hours = (70 - avgRisk) / riskChange;
    if (hours > 0 && hours < 48) {
      return "CRITICAL_IN_" + String((int)hours) + "_HOURS";
    }
  }
  
  if (avgRisk > 70) return "IMMEDIATE_ACTION";
  if (avgRisk > 50) return "MONITOR_CLOSELY";
  if (avgRisk > 30) return "STABLE_WATCH";
  
  return "CONDITIONS_GOOD";
}

// ==================== DATA TRANSMISSION ====================
void sendStartupAnnouncement() {
  DynamicJsonDocument doc(1024);
  
  doc["deviceId"] = deviceId;
  doc["temperature"] = 0.0;
  doc["humidity"] = 0.0;
  doc["mq_value"] = 0.0;
  doc["spoilageRisk"] = 0.0;
  doc["grainHealth"] = "ONLINE";
  doc["dewPoint"] = 0.0;
  doc["absoluteHumidity"] = 0.0;
  doc["vaporPressureDeficit"] = 0.0;
  doc["equilibriumMoistureContent"] = 0.0;
  doc["trendAnalysis"] = "STARTING";
  doc["prediction"] = "INITIALIZING";
  doc["rssi"] = WiFi.RSSI();
  doc["ip"] = WiFi.localIP().toString();
  
  String payload;
  serializeJson(doc, payload);
  
  Serial.println("📤 Startup announcement...");
  Serial.println("JSON: " + payload);
  postJson(payload);
}

void processSensorData() {
  float temp, hum, mq_value;
  if (!readSensors(temp, hum, mq_value)) {
    Serial.println("❌ Failed to read sensors");
    return;
  }
  
  float risk = calculateSpoilageRisk(temp, hum);
  String health = determineGrainHealth(risk);
  float dewPt = calculateDewPoint(temp, hum);
  float absHum = calculateAbsoluteHumidity(temp, hum);
  float vpd = calculateVaporPressureDeficit(temp, hum);
  float emc = calculateEquilibriumMoistureContent(temp, hum);
  String trend = analyzeTrends();
  String prediction = generatePredictions();
  
  // Alarm logic (automatic triggering with hardcoded thresholds)
  if (risk > ALARM_TRIGGER_THRESHOLD && !alarmActive) {
    Serial.printf("🚨 ALARM TRIGGERED! Risk: %.1f%% > %.1f%%\n", risk, ALARM_TRIGGER_THRESHOLD);
    startAlarm();
  }
  if (risk <= ALARM_STOP_THRESHOLD && alarmActive) {
    Serial.printf("✅ Risk normalized: %.1f%% <= %.1f%%\n", risk, ALARM_STOP_THRESHOLD);
    stopAlarm();
  }
  
  // Build JSON using ArduinoJson library (proper way)
  DynamicJsonDocument doc(1024);
  
  doc["deviceId"] = deviceId;
  doc["temperature"] = serialized(String(temp, 1));
  doc["humidity"] = serialized(String(hum, 1));
  doc["mq_value"] = serialized(String(mq_value, 0));
  doc["spoilageRisk"] = serialized(String(risk, 1));
  doc["grainHealth"] = health;
  doc["dewPoint"] = serialized(String(dewPt, 1));
  doc["absoluteHumidity"] = serialized(String(absHum, 1));
  doc["vaporPressureDeficit"] = serialized(String(vpd, 2));
  doc["equilibriumMoistureContent"] = serialized(String(emc, 1));
  doc["trendAnalysis"] = trend;
  doc["prediction"] = prediction;
  doc["rssi"] = WiFi.RSSI();
  doc["ip"] = WiFi.localIP().toString();
  
  String payload;
  serializeJson(doc, payload);
  
  Serial.printf("🌡️ Temp: %.1f°C | 💧 Hum: %.1f%% | ⚠️ Risk: %.1f%% | MQ: %.0f\n", temp, hum, risk, mq_value);
  Serial.println("JSON: " + payload);
  
  postJson(payload);
}

// bool postJson(const String &payload) {
//   if (WiFi.status() != WL_CONNECTED) {
//     Serial.println("❌ WiFi not connected");
//     return false;
//   }
  
//   Serial.println("\n📤 Sending data...");
//   Serial.println("Payload size: " + String(payload.length()) + " bytes");
  
//   WiFiClientSecure client;
//   HTTPClient http;
  
//   // Disable SSL certificate verification (for development/testing)
//   // For production, you should use proper certificate validation
//   client.setInsecure();
  
//   http.setReuse(false);
//   http.setTimeout(15000);
//   http.begin(client, serverUrl);
//   http.addHeader("Content-Type", "application/json");
//   http.addHeader("x-api-key", API_KEY);
//   http.addHeader("Connection", "close");
  
//   int httpCode = http.POST(payload);
//   bool success = (httpCode > 0 && httpCode < 300);
  
//   if (success) {
//     Serial.printf("✅ Data sent (HTTP %d)\n", httpCode);
//     String response = http.getString();
//     Serial.println("Response: " + response);
//   } else {
//     Serial.printf("❌ HTTP Error: %d\n", httpCode);
//     if (httpCode > 0) {
//       String response = http.getString();
//       Serial.println("Error response: " + response);
//     } else {
//       Serial.println("Connection error: " + http.errorToString(httpCode));
//     }
//   }
  
//   http.end();
//   client.stop();
  
//   return success;
// }

bool postJson(const String &payload) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("❌ WiFi not connected");
    return false;
  }
  
  Serial.println("\n📤 Sending data...");
  Serial.println("Payload size: " + String(payload.length()) + " bytes");
  
  WiFiClient client;  // ← Changed from WiFiClientSecure
  HTTPClient http;
  
  http.setReuse(false);
  http.setTimeout(15000);
  http.begin(client, serverUrl);  // ← Use regular client
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);
  http.addHeader("Connection", "close");
  
  int httpCode = http.POST(payload);
  bool success = (httpCode > 0 && httpCode < 300);
  
  if (success) {
    Serial.printf("✅ Data sent (HTTP %d)\n", httpCode);
    String response = http.getString();
    Serial.println("Response: " + response);
  } else {
    Serial.printf("❌ HTTP Error: %d\n", httpCode);
    if (httpCode > 0) {
      String response = http.getString();
      Serial.println("Error response: " + response);
    } else {
      Serial.println("Connection error: " + http.errorToString(httpCode));
    }
  }
  
  http.end();
  client.stop();
  
  return success;
}

// ==================== CONFIGURATION FETCHING ====================
bool fetchConfig() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("❌ WiFi not connected, cannot fetch config");
    return false;
  }
  
  Serial.println("\n📥 Fetching configuration from server...");
  
  WiFiClient client;
  HTTPClient http;
  
  // Build config URL from server URL
  String configUrl = serverUrl;
  configUrl.replace("/api/data", "/api/config");
  
  http.setTimeout(10000);
  http.begin(client, configUrl);
  
  int httpCode = http.GET();
  
  if (httpCode == 200) {
    String payload = http.getString();
    Serial.println("✅ Config received");
    
    // Parse JSON configuration
    DynamicJsonDocument doc(4096);
    DeserializationError error = deserializeJson(doc, payload);
    
    if (error) {
      Serial.print("❌ JSON parse error: ");
      Serial.println(error.c_str());
      http.end();
      client.stop();
      return false;
    }
    
    // Update thresholds from config
    JsonObject thresholds = doc["thresholds"];
    if (thresholds) {
      // Temperature
      if (thresholds["temperature"]) {
        TEMP_IDEAL_MIN = thresholds["temperature"]["idealMin"] | TEMP_IDEAL_MIN;
        TEMP_IDEAL_MAX = thresholds["temperature"]["idealMax"] | TEMP_IDEAL_MAX;
        TEMP_WARNING_MIN = thresholds["temperature"]["warningMin"] | TEMP_WARNING_MIN;
        TEMP_WARNING_MAX = thresholds["temperature"]["warningMax"] | TEMP_WARNING_MAX;
        TEMP_CRITICAL_MIN = thresholds["temperature"]["criticalMin"] | TEMP_CRITICAL_MIN;
        TEMP_CRITICAL_MAX = thresholds["temperature"]["criticalMax"] | TEMP_CRITICAL_MAX;
      }
      
      // Humidity
      if (thresholds["humidity"]) {
        HUM_IDEAL_MIN = thresholds["humidity"]["idealMin"] | HUM_IDEAL_MIN;
        HUM_IDEAL_MAX = thresholds["humidity"]["idealMax"] | HUM_IDEAL_MAX;
        HUM_WARNING_MIN = thresholds["humidity"]["warningMin"] | HUM_WARNING_MIN;
        HUM_WARNING_MAX = thresholds["humidity"]["warningMax"] | HUM_WARNING_MAX;
        HUM_CRITICAL_MIN = thresholds["humidity"]["criticalMin"] | HUM_CRITICAL_MIN;
        HUM_CRITICAL_MAX = thresholds["humidity"]["criticalMax"] | HUM_CRITICAL_MAX;
      }
      
      // Air Quality
      if (thresholds["airQuality"]) {
        AIR_QUALITY_GOOD = thresholds["airQuality"]["good"] | AIR_QUALITY_GOOD;
        AIR_QUALITY_MODERATE = thresholds["airQuality"]["moderate"] | AIR_QUALITY_MODERATE;
        AIR_QUALITY_POOR = thresholds["airQuality"]["poor"] | AIR_QUALITY_POOR;
        AIR_QUALITY_CRITICAL = thresholds["airQuality"]["veryPoor"] | AIR_QUALITY_CRITICAL;
      }
      
      // Spoilage Risk
      if (thresholds["spoilageRisk"]) {
        RISK_LOW = thresholds["spoilageRisk"]["low"] | RISK_LOW;
        RISK_MEDIUM = thresholds["spoilageRisk"]["medium"] | RISK_MEDIUM;
        RISK_HIGH = thresholds["spoilageRisk"]["high"] | RISK_HIGH;
        RISK_CRITICAL = thresholds["spoilageRisk"]["critical"] | RISK_CRITICAL;
      }
      
      // Condensation
      if (thresholds["condensation"]) {
        DEW_POINT_DIFF = thresholds["condensation"]["dewPointDifference"] | DEW_POINT_DIFF;
      }
    }
    
    // Update alerts configuration
    JsonObject alerts = doc["alerts"];
    if (alerts) {
      buzzerEnabled = alerts["buzzerEnabled"] | buzzerEnabled;
      ALARM_DURATION = alerts["buzzerDuration"] | ALARM_DURATION;
      ALARM_TRIGGER_THRESHOLD = alerts["criticalRiskThreshold"] | ALARM_TRIGGER_THRESHOLD;
      ALARM_STOP_THRESHOLD = ALARM_TRIGGER_THRESHOLD - 20; // Auto-calculate stop threshold
    }
    
    // Update data collection settings
    JsonObject dataCollection = doc["dataCollection"];
    if (dataCollection) {
      SAMPLE_INTERVAL_MS = dataCollection["sampleInterval"] | SAMPLE_INTERVAL_MS;
      int newHistorySize = dataCollection["historySize"] | HISTORY_SIZE;
      // Clamp history size to fixed maximum
      HISTORY_SIZE = (newHistorySize > MAX_HISTORY_SIZE) ? MAX_HISTORY_SIZE : newHistorySize;
      if (HISTORY_SIZE < 3) HISTORY_SIZE = 3; // Ensure minimum for trends
    }
    
    Serial.println("✅ Configuration updated successfully");
    Serial.printf("   Buzzer: %s\n", buzzerEnabled ? "ENABLED" : "DISABLED");
    Serial.printf("   Sample Interval: %d ms\n", SAMPLE_INTERVAL_MS);
    Serial.printf("   Alarm Threshold: %.1f%%\n", ALARM_TRIGGER_THRESHOLD);
    Serial.printf("   Temp Range: %.1f-%.1f°C\n", TEMP_IDEAL_MIN, TEMP_IDEAL_MAX);
    Serial.printf("   Humidity Range: %.1f-%.1f%%\n", HUM_IDEAL_MIN, HUM_IDEAL_MAX);
    
    http.end();
    client.stop();
    configFetched = true;
    return true;
    
  } else {
    Serial.printf("❌ Config fetch failed (HTTP %d)\n", httpCode);
    http.end();
    client.stop();
    return false;
  }
}

// ==================== HARDWARE CONTROLS ====================
void handleButtons() {
  unsigned long now = millis();
  
  // Button 1 - Manual reading (single press) / Buzzer toggle (double press)
  if (digitalRead(BUTTON1_PIN) == LOW) {
    if (now - lastButton1Press > DEBOUNCE_DELAY) {
      lastButton1Press = now;
      
      // Check if this is a double-press
      if (waitingForSecondPress && (now - lastButton1SinglePress < DOUBLE_PRESS_WINDOW)) {
        Serial.println("🔘 Button 1 Double - Toggle buzzer");
        beep(50);
        delay(50);
        beep(50);
        
        buzzerEnabled = !buzzerEnabled;
        if (buzzerEnabled) {
          Serial.println("🔊 Buzzer ENABLED");
        } else {
          Serial.println("🔇 Buzzer DISABLED");
        }
        waitingForSecondPress = false;
      } else {
        // First press - wait for potential second press
        lastButton1SinglePress = now;
        waitingForSecondPress = true;
      }
    }
  }
  
  // Check if waiting period expired - execute single press action
  if (waitingForSecondPress && (now - lastButton1SinglePress >= DOUBLE_PRESS_WINDOW)) {
    Serial.println("🔘 Button 1 - Manual reading");
    beep(50);
    processSensorData();
    waitingForSecondPress = false;
  }
  
  // Button 2 - LED test / Factory reset
  int buttonVal = analogRead(BUTTON2_PIN);
  if (buttonVal < 100) {
    if (now - lastButton2Press > DEBOUNCE_DELAY) {
      lastButton2Press = now;
      Serial.println("🔘 Button 2 - LED toggle");
      beep(50);
      digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    }
    
    if (now - lastButton2Press > 5000) {
      Serial.println("🔘 Long press - Factory reset");
      beep(500);
      factoryReset();
    }
  }
}

void handleBuzzer() {
  if (alarmActive) {
    if (buzzerEnabled) {
      // Continuous beeping pattern while alarm is active
      int cycle = (millis() / 200) % 4;
      digitalWrite(BUZZER_PIN, (cycle == 0 || cycle == 1) ? HIGH : LOW);
    } else {
      // Buzzer disabled by user, but alarm still active (LED blinks)
      digitalWrite(BUZZER_PIN, LOW);
    }
  } else {
    digitalWrite(BUZZER_PIN, LOW);
  }
}

void beep(int duration) {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(duration);
  digitalWrite(BUZZER_PIN, LOW);
}

void startAlarm() {
  if (!alarmActive) {
    alarmActive = true;
    alarmStartTime = millis();
    Serial.println("🚨 Alarm activated");
  }
}

void stopAlarm() {
  alarmActive = false;
  digitalWrite(BUZZER_PIN, LOW);
  Serial.println("🔇 Alarm stopped");
}
