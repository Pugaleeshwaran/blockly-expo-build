// App.js
import React, { useRef, useEffect, useCallback } from "react";
import {
  Platform,
  SafeAreaView,
  View,
  Alert,
  DeviceEventEmitter,
} from "react-native";
import { WebView } from "react-native-webview";
import * as ScreenOrientation from "expo-screen-orientation";

// We'll load rn-usb-serial ONLY on Android, at runtime
let RNSerialport = null;
let SerialActions = null;

// ---------- 1) Build STM32 protocol message ----------
function buildPycodeMessage(code, entry = "main") {
  const size = code.length;
  return `PYCODE\nENTRY:${entry}\nSIZE:${size}\n\n${code}`;
}

// ---------- 2) Ensure USB module is loaded (Android only) ----------
function ensureSerialModule() {
  if (Platform.OS !== "android") {
    console.log("rn-usb-serial only used on Android");
    return false;
  }

  if (RNSerialport && SerialActions) {
    return true; // already loaded
  }

  try {
    // ✅ require only at runtime, only on Android
    const Serial = require("rn-usb-serial");
    RNSerialport = Serial.RNSerialport;
    SerialActions = Serial.actions;
    return true;
  } catch (e) {
    console.warn("Unable to load rn-usb-serial:", e);
    Alert.alert(
      "USB module error",
      "rn-usb-serial could not be loaded. Check installation."
    );
    return false;
  }
}

// ---------- 3) USB start/stop ----------
function startUsbService() {
  if (!ensureSerialModule()) return;

  // Set up listeners
  DeviceEventEmitter.addListener(SerialActions.ON_CONNECTED, () => {
    console.log("USB: STM32 connected");
  });

  DeviceEventEmitter.addListener(SerialActions.ON_DISCONNECTED, () => {
    console.log("USB: STM32 disconnected");
  });

  DeviceEventEmitter.addListener(SerialActions.ON_READ_DATA, (data) => {
    console.log("STM32 -> phone:", data.payload);
  });

  try {
    RNSerialport.setInterface(-1);
    RNSerialport.setAutoConnectBaudRate(115200);
    RNSerialport.setAutoConnect(true);
    RNSerialport.startUsbService();
    console.log("USB service started");
  } catch (e) {
    console.warn("Failed to start USB service:", e);
  }
}

function stopUsbService() {
  if (!RNSerialport || !SerialActions || Platform.OS !== "android") return;

  try {
    DeviceEventEmitter.removeAllListeners();
    RNSerialport.isOpen((isOpen) => {
      if (isOpen) {
        RNSerialport.disconnect();
      }
      RNSerialport.stopUsbService();
    });
  } catch (e) {
    console.warn("Error stopping USB service:", e);
  }
}

// ---------- 4) Send a message to STM32 ----------
function sendToBoard(message) {
  if (Platform.OS !== "android") {
    console.log("Would send to STM32 (non-Android):\n", message);
    Alert.alert("Info", "USB send is only wired for Android right now.");
    return;
  }

  if (!ensureSerialModule()) return;

  try {
    RNSerialport.writeString(message);
    console.log("Sent to STM32 over USB:\n", message);
    Alert.alert("Sent", "Code sent over USB to STM32.");
  } catch (e) {
    console.warn("Error sending over USB:", e);
    Alert.alert("USB error", "Failed to send to STM32.");
  }
}

// ---------- 5) Main App component ----------
export default function App() {
  const ref = useRef(null);

  // Lock landscape
  useEffect(() => {
    if (Platform.OS !== "web") {
      ScreenOrientation.lockAsync(
        ScreenOrientation.OrientationLock.LANDSCAPE
      ).catch(() => {});
    }
  }, []);

  // Start/stop USB service on Android
  useEffect(() => {
    if (Platform.OS === "android") {
      startUsbService();
    }
    return () => {
      if (Platform.OS === "android") {
        stopUsbService();
      }
    };
  }, []);

  // Handle messages from index.html (WebView)
  const handleMessage = useCallback((event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === "py_preview") {
        console.log("Preview code:\n", data.code);
      }

      if (data.type === "python_upload") {
        const code = data.code || "";
        const entry = data.entry_function || "main";

        console.log("Upload requested with code:\n", code);

        const msg = buildPycodeMessage(code, entry);
        sendToBoard(msg);
      }
    } catch (e) {
      console.warn("Failed to parse message from WebView:", e);
    }
  }, []);

  // Web support
  if (Platform.OS === "web") {
    const htmlUrl = require("./assets/blockly/index.html");
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>
          <iframe
            title="Blockly"
            src={htmlUrl}
            style={{ width: "100%", height: "100%", border: "none" }}
          />
        </View>
      </SafeAreaView>
    );
  }

  // Android / iOS
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <WebView
        ref={ref}
        originWhitelist={["*"]}
        source={require("./assets/blockly/index.html")}
        allowFileAccess
        allowUniversalAccessFromFileURLs
        onMessage={handleMessage}
      />
    </SafeAreaView>
  );
}
