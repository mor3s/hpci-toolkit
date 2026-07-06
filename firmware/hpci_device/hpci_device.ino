#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME680.h>
#include <Adafruit_ADS1X15.h>

const char* WIFI_SSID = "Laptop-Nour";
const char* WIFI_PASS = "123456789";
const char* SERVER    = "http://192.168.137.1:3000";
String deviceId = "device-2";

JsonDocument config;
unsigned long lastSample = 0;
unsigned long sampleEvery = 5000;

Adafruit_BME680 bme;              // the BME object
Adafruit_ADS1115 ads;            // the ADS1115 object
bool bmeReady = false;            // did each chip initialise? (we only read if so)
bool adsReady = false;

unsigned long lastOutput = 0;
const unsigned long OUTPUT_EVERY = 1000;   // check desired colors once a second

void fetchConfig() {
  HTTPClient http;
  http.begin(String(SERVER) + "/devices/" + deviceId + "/config");
  int code = http.GET();
  if (code != 200) { Serial.println("config fetch failed: " + String(code)); http.end(); return; }
  String body = http.getString();
  http.end();
  config.clear();
  if (deserializeJson(config, body)) { Serial.println("parse failed"); return; }
  sampleEvery = config["sample_interval_ms"] | 5000;
  Serial.println("Config loaded.");
}


void setup() {
  Serial.begin(115200);
  delay(500);

  Wire.begin(21, 22);                       // start I2C once for any I2C sensor

  // try to bring up each I2C chip; remember whether it worked
  if (bme.begin(0x77)) {
    bme.setTemperatureOversampling(BME680_OS_8X);
    bme.setHumidityOversampling(BME680_OS_2X);
    bme.setPressureOversampling(BME680_OS_4X);
    bme.setIIRFilterSize(BME680_FILTER_SIZE_3);
    bme.setGasHeater(320, 150);
    bmeReady = true;
  } else Serial.println("no BME680 found (ok if not using it)");

  if (ads.begin(0x48)) {
    ads.setGain(GAIN_TWOTHIRDS);            // wide ±6.144V for now; we'll tighten this
    adsReady = true;
  } else Serial.println("no ADS1115 found (ok if not using it)");

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\nWiFi connected: " + WiFi.localIP().toString());
  fetchConfig();

  // set up PWM for each output's three pins
  for (JsonObject output : config["outputs"].as<JsonArray>()) {
    if (String(output["type"] | "") == "rgb") {
      ledcAttach(output["pins"]["r"] | -1, 5000, 8);   // 5 kHz, 8-bit (0..255)
      ledcAttach(output["pins"]["g"] | -1, 5000, 8);
      ledcAttach(output["pins"]["b"] | -1, 5000, 8);
    }
  }
}

void loop() {
  unsigned long now = millis();
  JsonDocument out;                     // collect everything DUE this pass
  out["device_id"] = deviceId;
  JsonArray readings = out["readings"].to<JsonArray>();

  for (JsonObject input : config["inputs"].as<JsonArray>()) {
    unsigned long interval = input["interval_ms"] | sampleEvery;   // per-input, else global
    unsigned long last     = input["_last"] | 0UL;                 // when we last read THIS one

    if (now - last < interval) continue;       // not due yet — skip it
    input["_last"] = now;                      // mark it read now

    String source = input["source"] | "";
    String nm     = input["name"]   | "?";

    if (source == "adc") {
      int pin = input["pin"] | -1;
      if (pin >= 0) { JsonObject r = readings.add<JsonObject>(); r["name"]=nm; r["value"]=analogRead(pin); }
    }
    else if (source == "ads1115" && adsReady) {
      float mv = ads.computeVolts(ads.readADC_Differential_0_1()) * 1000.0;
      JsonObject r = readings.add<JsonObject>(); r["name"]=nm; r["value"]=mv;
    }
    else if (source == "i2c" && bmeReady) {
      if (bme.performReading()) {
        JsonObject t=readings.add<JsonObject>(); t["name"]=nm+".temperature"; t["value"]=bme.temperature;
        JsonObject h=readings.add<JsonObject>(); h["name"]=nm+".humidity";    h["value"]=bme.humidity;
        JsonObject p=readings.add<JsonObject>(); p["name"]=nm+".pressure";    p["value"]=bme.pressure/100.0;
        JsonObject g=readings.add<JsonObject>(); g["name"]=nm+".gas";         g["value"]=bme.gas_resistance/1000.0;
      }
    }
  }
  if (now - lastOutput > OUTPUT_EVERY) {     // NEW: drive outputs once a second
    applyOutputs();
    lastOutput = now;
  }
  if (readings.size() > 0) {                   // only POST if something was due
    String body; serializeJson(out, body);
    HTTPClient http;
    http.begin(String(SERVER) + "/readings");
    http.addHeader("Content-Type", "application/json");
    http.POST(body);
    http.end();
    Serial.println("posted " + String(readings.size()) + " readings");
  }
}

void applyOutputs() {
  HTTPClient http;
  http.begin(String(SERVER) + "/devices/" + deviceId + "/outputs/desired");
  int code = http.GET();
  if (code != 200) { http.end(); return; }
  String body = http.getString();
  http.end();

  JsonDocument desired;                       // { "leaf_light": {"r":..,"g":..,"b":..}, ... }
  if (deserializeJson(desired, body)) return;

  for (JsonObject output : config["outputs"].as<JsonArray>()) {
    String name = output["name"] | "";
    if (String(output["type"] | "") != "rgb") continue;
    if (!desired[name].is<JsonObject>()) continue;        // no color set for this output yet

    int r = desired[name]["r"] | 0;
    int g = desired[name]["g"] | 0;
    int b = desired[name]["b"] | 0;

    ledcWrite(output["pins"]["r"] | -1, r);               // drive each channel to its brightness
    ledcWrite(output["pins"]["g"] | -1, g);
    ledcWrite(output["pins"]["b"] | -1, b);

    // report back what we actually set
    JsonDocument rep; rep["r"] = r; rep["g"] = g; rep["b"] = b;
    String repBody; serializeJson(rep, repBody);
    HTTPClient rh;
    rh.begin(String(SERVER) + "/devices/" + deviceId + "/outputs/" + name + "/reported");
    rh.addHeader("Content-Type", "application/json");
    rh.PUT(repBody);
    rh.end();
  }
}