import { useAssets } from 'expo-asset';
import React, { useEffect, useCallback, useState } from "react";
import { Platform, View, Alert, DeviceEventEmitter, PermissionsAndroid } from "react-native";
import { WebView } from "react-native-webview";
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import * as NavigationBar from "expo-navigation-bar";

// BLE IMPORTS
import { BleManager } from 'react-native-ble-plx';
import base64 from 'react-native-base64';

// UUIDs (must match the robot board)
const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const WRITE_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";

// ---------------------------------------------------------------------------
// USB (Android only, lazy-loaded)
// ---------------------------------------------------------------------------
let RNSerialport = null;
let SerialActions = null;

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

// ---------------------------------------------------------------------------
// BLE Manager — created ONCE at module level, safely
// ---------------------------------------------------------------------------
let bleManagerInstance = null;
if (Platform.OS !== 'web') {
  try {
    bleManagerInstance = new BleManager();
  } catch (e) {
    console.log("BLE Manager init failed:", e);
  }
}

// ---------------------------------------------------------------------------
// App Component
// ---------------------------------------------------------------------------
export default function App() {
  const webViewRef = React.useRef(null);
  const [bleManager] = useState(bleManagerInstance);

  // Use a REF (not state) for connectedDevice so that all callbacks always
  // close over the *latest* device without needing to re-create the functions.
  // setConnectedDevice still exists so the UI can re-render if needed.
  const connectedDeviceRef = React.useRef(null);
  const [, forceRender] = React.useState(0);

  const setConnectedDevice = (device) => {
    connectedDeviceRef.current = device;
    forceRender(n => n + 1); // optional: trigger re-render
  };

  /** Safely run JavaScript inside the WebView */
  const injectJS = (jsCode) => {
    webViewRef.current?.injectJavaScript(jsCode + '; true;');
  };

  // ── Permissions & lifecycle ──────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
        ]);

        const allGranted =
          granted['android.permission.BLUETOOTH_SCAN'] === 'granted' &&
          granted['android.permission.BLUETOOTH_CONNECT'] === 'granted' &&
          granted['android.permission.ACCESS_FINE_LOCATION'] === 'granted';

        if (!allGranted) {
          Alert.alert(
            "Permission Required",
            "Go to Phone Settings > Apps > [App] > Permissions and allow Bluetooth and Location manually."
          );
        }

        NavigationBar.setVisibilityAsync("hidden").catch(() => { });
      }

      if (Platform.OS !== "web") {
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => { });
        startUsbService();
      }
    })();

    return () => {
      // NOTE: Do NOT call bleManager.destroy() here.
      // The BleManager is a module-level singleton. Destroying it on unmount
      // (e.g. hot-reload) kills Bluetooth for the rest of the app session.
      // Just stop any ongoing scan so we don't leak it.
      if (bleManager) {
        bleManager.stopDeviceScan();
      }
      if (Platform.OS === "android") {
        stopUsbService();
      }
    };
  }, [bleManager]);

  // ── BLE: Scan ─────────────────────────────────────────────────────────────
  const scanAndConnectBLE = useCallback(() => {
    if (!bleManager) {
      Alert.alert("BLE unavailable", "Bluetooth manager could not start.");
      return;
    }

    injectJS(`handleBoardMessage("Scanning…");`);

    bleManager.state().then(state => {
      if (state !== 'PoweredOn') {
        Alert.alert("Bluetooth Off", "Please turn on Bluetooth and Location.");
        injectJS(`handleBoardMessage("Bluetooth is OFF");`);
        return;
      }

      bleManager.startDeviceScan(null, { allowDuplicates: false }, (error, device) => {
        if (error) {
          console.log("Scan Error:", error);
          injectJS(`handleBoardMessage("Scan Error: ${error.reason || 'Check GPS/BT'}");`);
          return;
        }

        if (device && device.name) {
          console.log("Found:", device.name, device.id);
          const rssi = device.rssi || -50;
          // Send to the BT popup list in index.html
          injectJS(`addDeviceToUI("${device.name}", "${device.id}", ${rssi});`);
        }
      });

      // Auto-stop after 10 seconds
      setTimeout(() => {
        bleManager.stopDeviceScan();
        console.log("Scan stopped.");
      }, 10000);
    }).catch(e => {
      console.log("BLE state error:", e);
      injectJS(`handleBoardMessage("BLE Error: ${e.message}");`);
    });
  }, [bleManager]);

  // ── BLE: Connect to a specific device ────────────────────────────────────
  const connectToSpecificDevice = useCallback((deviceId) => {
    if (!deviceId) { console.log("No device ID!"); return; }
    if (!bleManager) return;

    bleManager.stopDeviceScan();
    injectJS(`handleBoardMessage("Connecting…");`);

    // KEY FIX: Always cancel any existing connection first.
    // Without this, the old GATT session stays open and writes
    // go to a dead connection → board gets garbage → prints help().
    const previousDevice = connectedDeviceRef.current;

    const doConnect = () => {
      bleManager.connectToDevice(deviceId)
        .then(device => device.discoverAllServicesAndCharacteristics())
        .then(async device => {
          setConnectedDevice(device);

          // ── Negotiate MTU for Large Payload Transfers ──────
          // Store the negotiated MTU on the device reference so sendToBoardBLE can use it
          device._mtu = 20;
          try {
            if (Platform.OS === 'android') {
              const negotiatedDevice = await device.requestMTU(512);
              device._mtu = negotiatedDevice.mtu;
              console.log("MTU successfully negotiated to:", device._mtu);
            } else {
              device._mtu = 185; // safe default for iOS
            }
          } catch (e) {
            console.log("MTU request failed, falling back to default", e);
            device._mtu = 20;
          }

          // ── Give GATT a moment to fully stabilise after (re)connect ──────
          // On Android, writing too fast after connectToDevice + discover
          // can silently drop the first packet even on a fresh connection.
          await new Promise(r => setTimeout(r, 80));

          // Always set the flag AND call finalizeConnection, even if the
          // WebView was reloaded since the last connection (stale flag fix).
          injectJS(`
            window._mobileBLEConnected = true;
            finalizeConnection("${device.name || 'Robot'}");
          `);

          console.log("Connected to:", device.name);

          // Listen for unexpected disconnects
          device.onDisconnected(() => {
            if (connectedDeviceRef.current && connectedDeviceRef.current.id === device.id) {
              setConnectedDevice(null);
              injectJS(`
                window._mobileBLEConnected = false;
                handleBoardMessage("BLE disconnected");
                var p = document.getElementById('bt-text');
                if (p) p.innerText = 'Bluetooth';
              `);
            }
          });
        })
        .catch(e => {
          console.log("Connection error:", e);
          injectJS(`handleBoardMessage("Connection failed: ${e.message.replace(/"/g, "'")}");`);
        });
    };

    if (previousDevice) {
      // Disconnect cleanly first, then connect fresh
      previousDevice.cancelConnection()
        .catch(() => { })
        .finally(() => {
          setConnectedDevice(null);
          // Extra pause after cancel so the peripheral's GATT server tears down
          // before we try to reconnect. Without this, connectToDevice can
          // succeed but writes silently fail on the first transfer.
          setTimeout(doConnect, 300);
        });
    } else {
      doConnect();
    }
  }, [bleManager]);

  // ── BLE: Send code in 20-byte chunks with 15 ms gap ──────────────────────
  const sendToBoardBLE = useCallback(async (data) => {
    // Always read from the REF so we get the latest device after reconnect
    const device = connectedDeviceRef.current;

    if (!device || !bleManager) {
      Alert.alert("Error", "Please connect to Bluetooth first");
      return;
    }

    try {
      // ── Verify the device is still actually connected ──────────────────
      // isConnected() checks the live GATT state, not just our cached ref.
      const stillConnected = await bleManager.isDeviceConnected(device.id).catch(() => false);
      if (!stillConnected) {
        // Device silently dropped — update our state and inform the UI
        setConnectedDevice(null);
        injectJS(`
          window._mobileBLEConnected = false;
          handleBoardMessage("BLE lost — please reconnect");
          var p = document.getElementById('bt-text'); if (p) p.innerText = 'Bluetooth';
        `);
        return;
      }

      // ── Send START marker using writeWithResponse ────────────────────────
      await bleManager.writeCharacteristicWithResponseForDevice(
        device.id, SERVICE_UUID, WRITE_UUID,
        base64.encode('@@START\n')
      );

      // ── Chunk the payload ───────────────────────────
      // We calculate the maximum safe text string length that can fit in our 
      // MTU limit (reserve 3 bytes for GATT overhead).
      // Base64 encoding inflates size, but ble-plx handles the text-to-bytes internally.
      // E.g., if MTU is 512, CHUNK is 500. If MTU failed to negotiate, CHUNK is ~20.
      const safeChunkSize = Math.max(20, (device._mtu || 20) - 12);

      for (let i = 0; i < data.length; i += safeChunkSize) {
        const slice = data.substring(i, i + safeChunkSize);
        // CRITICAL: use WithResponse for bulk chunks!
        // This acts as flow control. Android's Bluetooth stack will WAIT for the ESP32
        // to acknowledge the packet before moving to the next one, completely preventing
        // buffer drops and removing the need for `setTimeout()` hacks!
        await bleManager.writeCharacteristicWithResponseForDevice(
          device.id, SERVICE_UUID, WRITE_UUID,
          base64.encode(slice)
        );
      }

      // ── Send END marker ──────────────────────────────────────────────────
      await bleManager.writeCharacteristicWithResponseForDevice(
        device.id, SERVICE_UUID, WRITE_UUID,
        base64.encode('\n@@END')
      );

      injectJS(`handleBoardMessage("Upload Done! ✅");`);
    } catch (error) {
      console.error("Mobile BLE Send Error:", error);
      // If the write itself threw, the connection likely dropped silently.
      // Clean up state so the user knows to reconnect.
      const stillUp = await bleManager.isDeviceConnected(device.id).catch(() => false);
      if (!stillUp) {
        setConnectedDevice(null);
        injectJS(`
          window._mobileBLEConnected = false;
          var p = document.getElementById('bt-text'); if (p) p.innerText = 'Bluetooth';
        `);
      }
      injectJS(`handleBoardMessage("Send Failed ❌: ${String(error.message || error).replace(/"/g, "'")}");`);
    }
  }, [bleManager]);

  // ── BLE: Send a simple command string ────────────────────────────────────
  const sendCommandBLE = useCallback(async (command) => {
    const device = connectedDeviceRef.current;
    if (!device || !bleManager) {
      injectJS(`handleBoardMessage("No BLE connection");`);
      return;
    }
    try {
      // Verify device is still connected before sending command
      const stillConnected = await bleManager.isDeviceConnected(device.id).catch(() => false);
      if (!stillConnected) {
        setConnectedDevice(null);
        injectJS(`
          window._mobileBLEConnected = false;
          handleBoardMessage("BLE lost — please reconnect");
          var p = document.getElementById('bt-text'); if (p) p.innerText = 'Bluetooth';
        `);
        return;
      }
      // Use writeWithResponse for commands to guarantee delivery and avoid dropped packets
      await bleManager.writeCharacteristicWithResponseForDevice(
        device.id,
        SERVICE_UUID,
        WRITE_UUID,
        base64.encode(command + "\n")
      );
      injectJS(`handleBoardMessage("${command} sent ✅");`);
    } catch (e) {
      console.error("Command Error:", e);
      injectJS(`handleBoardMessage("Command failed ❌");`);
    }
  }, [bleManager]);

  // ── Message Bridge (index.html → App.js) ─────────────────────────────────
  const handleMessage = useCallback((event) => {
    let msg;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch (e) {
      console.warn("Bridge parse error:", e);
      return;
    }

    switch (msg.type) {
      case "CONNECT_BLE":
        // User clicked SCAN in the BT modal
        scanAndConnectBLE();
        break;

      case "SELECT_DEVICE":
        // User tapped a device card in the BT modal
        connectToSpecificDevice(msg.deviceId);
        break;

      case "SEND_DATA":
        // Upload button was pressed
        sendToBoardBLE(msg.data);
        break;

      case "COMMAND":
        // PLAY / STOP / SOFT_RESET / HARD_RESET etc.
        sendCommandBLE(msg.command);
        break;

      default:
        console.warn("Unknown bridge message type:", msg.type);
    }
  }, [scanAndConnectBLE, connectToSpecificDevice, sendToBoardBLE, sendCommandBLE]);

  // ── Asset loading ─────────────────────────────────────────────────────────
  const [assets] = useAssets([require('./assets/blockly/index.html')]);

  if (!assets) {
    return <View style={{ flex: 1, backgroundColor: '#cfeff2' }} />;
  }

  // ── Web platform (expo web fallback) ─────────────────────────────────────
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

  // ── Native (Android / iOS) ────────────────────────────────────────────────
  return (
    <View style={{ flex: 1 }}>
      <StatusBar hidden />
      <WebView
        ref={webViewRef}
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