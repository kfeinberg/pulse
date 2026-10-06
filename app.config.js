export default {
  expo: {
    name: "Pulse",
    slug: "nyc-happenings",
    version: "2.0.0",
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
          image: "./assets/images/splash-icon.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#ffffff",
          dark: {
            backgroundColor: "#000000",
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
