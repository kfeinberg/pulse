export default {
  expo: {
    name: "Pulse",
    slug: "nyc-happenings",
    version: "2.1.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "current",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    ios: {
      bundleIdentifier: "com.kfeinberg.pulse",
      supportsTablet: true,
      config: {
        googleMapsApiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY,
      },
      usesAppleSignIn: true,
      infoPlist: {
        NSLocationWhenInUseUsageDescription:
          "This app uses your location to show nearby events on the map.",
        ITSAppUsesNonExemptEncryption: false,
        CFBundleURLTypes: [
          {
            CFBundleURLSchemes: [
              "com.googleusercontent.apps.499823552737-erf8dj2janoieuipmg04kqbji5bdg4r0",
            ],
          },
        ],
      },
    },
    android: {
      package: "com.kfeinberg.pulse",
      adaptiveIcon: {
        backgroundColor: "#E6F4FE",
        foregroundImage: "./assets/images/android-icon-foreground.png",
        backgroundImage: "./assets/images/android-icon-background.png",
        monochromeImage: "./assets/images/android-icon-monochrome.png",
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
    },
    web: {
      output: "static",
      favicon: "./assets/images/favicon.png",
    },
    plugins: [
      "expo-router",
      "expo-font",
      "expo-image",
      "expo-status-bar",
      "expo-web-browser",
      [
        "expo-splash-screen",
        {
          // The art's own background is #1a1a1a. A matching launch color (in
          // light and dark mode) keeps it from showing as a box, and matches
          // the in-app splash that takes over from it.
          image: "./assets/images/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#1a1a1a",
          dark: {
            backgroundColor: "#1a1a1a",
          },
        },
      ],
      "expo-apple-authentication",
      "@react-native-google-signin/google-signin",
      "@react-native-community/datetimepicker",
      [
        "expo-notifications",
        {
          icon: "./assets/images/icon.png",
          color: "#ff5252",
        },
      ],
      "./plugins/with-react-native-maps-google",
      // Builds use Xcode 27 (iOS 27 SDK, required for App Store uploads from
      // April 2027). On SDK 57 the app must adopt the UIKit scene lifecycle to
      // launch on iOS 27; SDK 58+ does this by default, so drop it then.
      [
        "expo-build-properties",
        {
          ios: {
            enableSceneSupport: true,
          },
        },
      ],
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      router: {},
      eas: {
        projectId: "f7c62bd8-b16b-4227-8553-371a31a1b4f8",
      },
    },
  },
};
