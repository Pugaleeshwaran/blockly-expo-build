import { useAssets } from 'expo-asset';
import React, { useEffect, useCallback, useState } from "react";
import { Platform, View, Alert, DeviceEventEmitter, PermissionsAndroid } from "react-native";
import { WebView } from "react-native-webview";
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import * as NavigationBar from "expo-navigation-bar";

// 1. BLE IMPORTS
import { BleManager } from 'react-native-ble-plx';
import base64 from 'react-native-base64';

// YOUR UUIDS (Must match the robot board)
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const WRITE_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";

// Global variables for USB
let RNSerialport = null;
let SerialActions = null;

// ---------- 1) Build STM32 protocol message ----------
function buildPycodeMessage(code, entry = "main") {
  const size = code.length;
  return `PYCODE\nENTRY:${entry}\nSIZE:${size}\n\n${code}`;
}

// ---------- 2) Ensure USB module is loaded (Android only) ----------
function ensureSerialModule() {
  if (Platform.OS !== "android") return false;
  if (RNSerialport && SerialActions) return true;
  try {
    const Serial = require("rn-usb-serial");
    RNSerialport = Serial.RNSerialport;
    SerialActions = Serial.actions;
    return true;
  } catch (e) {
    console.warn("Unable to load rn-usb-serial:", e);
    return false;
  }
}

// ---------- 3) USB start/stop ----------
function startUsbService() {
  if (!ensureSerialModule()) return;
  DeviceEventEmitter.addListener(SerialActions.ON_CONNECTED, () => console.log("USB: Connected"));
  DeviceEventEmitter.addListener(SerialActions.ON_DISCONNECTED, () => console.log("USB: Disconnected"));
  try {
    RNSerialport.setInterface(-1);
    RNSerialport.setAutoConnectBaudRate(115200);
    RNSerialport.setAutoConnect(true);
    RNSerialport.startUsbService();
  } catch (e) {
    console.warn("Failed to start USB service:", e);
  }
}

function stopUsbService() {
  if (!RNSerialport || Platform.OS !== "android") return;
  try {
    DeviceEventEmitter.removeAllListeners();
    RNSerialport.stopUsbService();
  } catch (e) {
    console.warn("Error stopping USB service:", e);
  }
}

function sendToBoardUSB(message) {
  if (!ensureSerialModule()) return;
  try {
    RNSerialport.writeString(message);
    Alert.alert("USB Sent", "Code sent over USB.");
  } catch (e) {
    Alert.alert("USB Error", "Failed to send.");
  }
}

// ---------- 4) Main App Component ----------
export default function App() {
  const ref = React.useRef(null);
  const [connectedDevice, setConnectedDevice] = React.useState(null);

  // Initialize BLE Manager only on Mobile and safely handle null native modules
  const [bleManager] = React.useState(() => {
    if (Platform.OS !== 'web') {
      try {
        // We create the instance here. 
        // If the native module is missing, this is where it usually returns null.
        const manager = new BleManager();
        return manager;
      } catch (e) {
        console.error("BLE Native Module not found. Ensure you are running a Development Build.", e);
        return null;
      }
    }
    return null;
  });

  const injectJS = (jsCode) => {
    ref.current?.injectJavaScript(jsCode);
  };

  // --- Setup Permissions ---
  useEffect(() => {
    (async () => {
      if (Platform.OS === 'android') {
        await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
        NavigationBar.setVisibilityAsync("hidden");
      }
      if (Platform.OS !== "web") {
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => { });
        startUsbService();
      }
    })();
    return () => {
      if (Platform.OS === "android") stopUsbService();
    };
  }, []);

  // --- BLE: Scan & Connect ---
  const scanAndConnectBLE = () => {
    if (!bleManager) return;
    injectJS(`handleBoardMessage("Searching for ESP32 Robot...");`);

    bleManager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        injectJS(`handleBoardMessage("Scan Error: ${error.message}");`);
        return;
      }

      // --- ADD THIS FILTER ---
      // Replace "Curio" with the actual start of your robot's name
      if (device.name && device.name.includes("ESP32")) {
        console.log("Found our Robot:", device.name);
        bleManager.stopDeviceScan();

        device.connect()
          .then((d) => d.discoverAllServicesAndCharacteristics())
          .then((d) => {
            setConnectedDevice(d);
            injectJS(`handleBoardMessage("Connected to ${d.name}! ✅");`);
          })
          .catch((e) => injectJS(`handleBoardMessage("Error: ${e.message}");`));
      }
    });
  };

  // --- BLE: Send Data with Progress ---
  const sendToBoardBLE = async (codeString) => {
    if (!connectedDevice) {
      Alert.alert("Error", "Connect Bluetooth first!");
      return;
    }
    try {
      const chunkSize = 20;
      const totalChunks = Math.ceil(codeString.length / chunkSize);
      const writeChunk = async (str) => {
        const b64 = base64.encode(str);
        await connectedDevice.writeCharacteristicWithResponseForService(SERVICE_UUID, WRITE_UUID, b64);
      };

      await writeChunk("@@START\n");
      for (let i = 0, count = 0; i < codeString.length; i += chunkSize, count++) {
        const chunk = codeString.substring(i, i + chunkSize);
        await writeChunk(chunk);
        const percent = Math.round((count / totalChunks) * 100);
        injectJS(`handleBoardMessage("Uploading: ${percent}%");`);
      }
      await writeChunk("\n@@END");
      injectJS(`handleBoardMessage("Upload Complete! 🚀");`);
    } catch (error) {
      injectJS(`handleBoardMessage("Upload Failed: ${error.message}");`);
    }
  };

  // --- Message Bridge ---
  const handleMessage = useCallback((event) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === "CONNECT_BLE") scanAndConnectBLE();
      else if (msg.type === "SEND_DATA") sendToBoardBLE(msg.data);
      else if (msg.type === "python_upload") sendToBoardUSB(buildPycodeMessage(msg.code));
    } catch (e) {
      console.warn("Bridge Error", e);
    }
  }, [connectedDevice, bleManager]);

  // --- Asset Loading ---
  const [assets] = useAssets([require('./assets/blockly/index.html')]);

  if (!assets) {
    return <View style={{ flex: 1, backgroundColor: '#cfeff2' }} />;
  }

  // --- Render ---
  if (Platform.OS === "web") {
    return (
      <View style={{ flex: 1 }}>
        <StatusBar hidden />
        <iframe
          src={assets[0].uri}
          style={{ width: "100%", height: "100%", border: "none" }}
          title="Blockly Workspace"
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <StatusBar hidden />
      <WebView
        ref={ref}
        originWhitelist={["*"]}
        source={{ uri: assets[0].uri }}
        allowFileAccess
        allowUniversalAccessFromFileURLs
        onMessage={handleMessage}
        javaScriptEnabled={true}
        style={{ flex: 1 }}
      />
    </View>
  );
}