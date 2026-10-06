const fs = require('fs');
const path = require('path');
const { withFinalizedMod } = require('@expo/config-plugins');

const legacyGoogleMapsPod =
  "pod 'react-native-google-maps', path: File.dirname(`node --print \"require.resolve('react-native-maps/package.json')\"`)";
const googleMapsSubspecPod =
  "pod 'react-native-maps/Google', path: File.dirname(`node --print \"require.resolve('react-native-maps/package.json')\"`)";
const prepareReactNative = 'prepare_react_native_project!';

/**
 * Expo SDK 57 still generates the legacy react-native-google-maps pod name,
 * while react-native-maps 1.27 exposes Google Maps as a subspec. Rewrite the
 * finalized Podfile entry until Expo's built-in maps plugin adopts the new
 * podspec layout. Google Sign-In's AppCheckCore Swift pod also needs module
 * maps for GoogleUtilities and RecaptchaInterop, so enable modular headers.
 */
module.exports = function withReactNativeMapsGoogle(config) {
  return withFinalizedMod(config, ['ios', async (finalConfig) => {
    const podfilePath = path.join(finalConfig.modRequest.platformProjectRoot, 'Podfile');
    let contents = fs.readFileSync(podfilePath, 'utf8');

    if (contents.includes(legacyGoogleMapsPod)) {
      contents = contents.replace(legacyGoogleMapsPod, googleMapsSubspecPod);
    } else if (!contents.includes(googleMapsSubspecPod)) {
      const useNativeModules = '  config = use_native_modules!(config_command)';
      if (!contents.includes(useNativeModules)) {
        throw new Error('Could not locate the React Native autolinking Podfile setup');
      }
      contents = contents.replace(useNativeModules, `  ${googleMapsSubspecPod}\n${useNativeModules}`);
    }

    if (!contents.includes('use_modular_headers!')) {
      if (!contents.includes(prepareReactNative)) {
        throw new Error('Could not locate the React Native Podfile setup');
      }
      contents = contents.replace(prepareReactNative, `use_modular_headers!\n\n${prepareReactNative}`);
    }

    fs.writeFileSync(podfilePath, contents);
    return finalConfig;
  }]);
};
