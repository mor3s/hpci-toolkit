#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME680.h>
#include <Adafruit_ADS1X15.h>
#include <ESP32Servo.h>


const char* WIFI_SSID = "wifi-name";
const char* WIFI_PASS = "password";
const char* SERVER    = "http://192.168.137.1:3000";
String deviceId = "device-id";  // change for each ESP

JsonDocument config;
unsigned long lastSample = 0;
unsigned long sampleEvery = 5000;

Adafruit_BME680 bme;              // the BME object
Adafruit_ADS1115 ads;            // the ADS1115 object
bool bmeReady = false;            // did each chip initialise? (we only read if so)
bool adsReady = false;

unsigned long lastOutput = 0;
const unsigned long OUTPUT_EVERY = 1000;   // check desired colors once a second

Servo servos[4];              // up to 4 servos
int   servoPins[4] = {-1,-1,-1,-1};
int   servoCount = 0;

Servo* servoForPin(int pin) {
  for (int i = 0; i < servoCount; i++) if (servoPins[i] == pin) return &servos[i];
  if (servoCount < 4) {                       // first time we see this pin: attach
    servoPins[servoCount] = pin;
    servos[servoCount].attach(pin);
    return &servos[servoCount++];
  }
  return nullptr;
}



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
    String ty = output["type"] | "";
    if (ty == "rgb") {
      ledcAttach(output["pins"]["r"] | -1, 5000, 8);
      ledcAttach(output["pins"]["g"] | -1, 5000, 8);
      ledcAttach(output["pins"]["b"] | -1, 5000, 8);
    } else if (ty == "led" || ty == "buzzer") {
      pinMode(output["pins"]["s"] | -1, OUTPUT);         // single on/off pin
    } else if (ty == "servo") {
      servoForPin(output["pins"]["s"] | -1);       // attach it now
    }
    
  }
}

void loop() {
  unsigned long now = millis();
  JsonDocument out;                     // collect everything DUE this pass
  out["device_id"] = deviceId;
  JsonArray readings = out["readings"].to<JsonArray>();

  for (JsonObject input : config["inputs"].as<JsonArray>()) {
    String source = input["source"] | "";
    String nm     = input["name"]   | "?";

    // DIGITAL inputs (button, mic-trigger): check EVERY pass, post on change + heartbeat
    if (source == "digital") {
      int pin = input["pin"] | -1;
      if (pin >= 0) {
        pinMode(pin, INPUT_PULLUP);
        int state = digitalRead(pin);
        int lastState = input["_lastState"] | -1;
        unsigned long lastBeat = input["_lastBeat"] | 0UL;
        unsigned long beatEvery = input["interval_ms"] | 5000;   // heartbeat interval

        if (state != lastState || (now - lastBeat) >= beatEvery) {
          input["_lastState"] = state;
          input["_lastBeat"]  = now;
          JsonObject r = readings.add<JsonObject>(); r["name"]=nm; r["value"]=state;
        }
      }
      continue;   // handled — skip the normal interval gate below
    }

    // everything else: the normal per-interval gate
    unsigned long interval = input["interval_ms"] | sampleEvery;
    unsigned long last     = input["_last"] | 0UL;
    if (now - last < interval) continue;
    input["_last"] = now;

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
    String ty   = output["type"] | "";
    if (!desired[name].is<JsonObject>()) continue;

    if (ty == "rgb") {
      int r = desired[name]["r"] | 0, g = desired[name]["g"] | 0, b = desired[name]["b"] | 0;
      ledcWrite(output["pins"]["r"] | -1, r);
      ledcWrite(output["pins"]["g"] | -1, g);
      ledcWrite(output["pins"]["b"] | -1, b);
      JsonDocument rep; rep["r"]=r; rep["g"]=g; rep["b"]=b;
      String repBody; serializeJson(rep, repBody);
      HTTPClient rh; rh.begin(String(SERVER) + "/devices/" + deviceId + "/outputs/" + name + "/reported");
      rh.addHeader("Content-Type","application/json"); rh.PUT(repBody); rh.end();
    }
    else if (ty == "led" || ty == "buzzer") {
      // single-pin output: ON if the desired colour is not black
      int r = desired[name]["r"] | 0, g = desired[name]["g"] | 0, b = desired[name]["b"] | 0;
      bool on = (r + g + b) > 0;
      digitalWrite(output["pins"]["s"] | -1, on ? HIGH : LOW);
      JsonDocument rep; rep["r"]=r; rep["g"]=g; rep["b"]=b;   // echo back what we got
      String repBody; serializeJson(rep, repBody);
      HTTPClient rh; rh.begin(String(SERVER) + "/devices/" + deviceId + "/outputs/" + name + "/reported");
      rh.addHeader("Content-Type","application/json"); rh.PUT(repBody); rh.end();
    } else if (ty == "servo") {
      int angle = desired[name]["angle"] | -1;
      if (angle >= 0 && angle <= 180) {
        Servo* s = servoForPin(output["pins"]["s"] | -1);
        if (s) s->write(angle);
        JsonDocument rep; rep["angle"] = angle;                 // report back the angle
        String repBody; serializeJson(rep, repBody);
        HTTPClient rh; rh.begin(String(SERVER) + "/devices/" + deviceId + "/outputs/" + name + "/reported");
        rh.addHeader("Content-Type","application/json"); rh.PUT(repBody); rh.end();
      }
    } else if (ty == "speaker") {
      int freq = desired[name]["freq"] | 0;
      int pin  = output["pins"]["s"] | -1;
      if (pin >= 0) {
        if (freq > 0) tone(pin, freq);      // play the pitch
        else          noTone(pin);          // 0 = silence
      }
      JsonDocument rep; rep["freq"] = freq;
      String repBody; serializeJson(rep, repBody);
      HTTPClient rh; rh.begin(String(SERVER) + "/devices/" + deviceId + "/outputs/" + name + "/reported");
      rh.addHeader("Content-Type","application/json"); rh.PUT(repBody); rh.end();
    }
  }
}