// Minimal history router mirroring expo-router's push/back used by the mobile app.
let inAppNavigations = 0;

export function navigate(path: string): void {
  inAppNavigations += 1;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function goBack(fallback = '/'): void {
  if (inAppNavigations > 0) {
    inAppNavigations -= 1;
    window.history.back();
  } else {
    navigate(fallback);
  }
}
