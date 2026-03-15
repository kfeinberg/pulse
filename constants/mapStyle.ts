export const MAP_STYLE = [
  // Base geometry — warm buttercream
  {
    elementType: 'geometry',
    stylers: [{ color: '#faf3e0' }],
  },
  // Default labels — warm taupe
  {
    elementType: 'labels.text.fill',
    stylers: [{ color: '#baa898' }],
  },
  {
    elementType: 'labels.text.stroke',
    stylers: [{ color: '#faf3e0' }, { weight: 2 }],
  },
  // Hide ALL label icons
  {
    elementType: 'labels.icon',
    stylers: [{ visibility: 'off' }],
  },

  // === ADMINISTRATIVE LABELS ===
  {
    featureType: 'administrative.country',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'administrative.province',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'administrative.locality',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },
  // Neighborhood labels — warm sand
  {
    featureType: 'administrative.neighborhood',
    elementType: 'labels',
    stylers: [{ visibility: 'on' }],
  },
  {
    featureType: 'administrative.neighborhood',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#b8a494' }],
  },
  {
    featureType: 'administrative.neighborhood',
    elementType: 'labels.text.stroke',
    stylers: [{ color: '#faf3e0' }, { weight: 3 }],
  },
  // Hide admin borders
  {
    featureType: 'administrative',
    elementType: 'geometry',
    stylers: [{ visibility: 'off' }],
  },

  // === POI ===
  {
    featureType: 'poi',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },
  // POI geometry — warm sand
  {
    featureType: 'poi',
    elementType: 'geometry',
    stylers: [{ color: '#f0e8da' }],
  },
  // Parks — candy mint green
  {
    featureType: 'poi.park',
    elementType: 'geometry.fill',
    stylers: [{ color: '#c6e8b4' }],
  },

  // === LANDSCAPE ===
  // Man-made — warm vanilla
  {
    featureType: 'landscape.man_made',
    elementType: 'geometry.fill',
    stylers: [{ color: '#fceee0' }],
  },
  {
    featureType: 'landscape.man_made',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#e4daca' }, { weight: 0.5 }],
  },
  // Natural — soft sage
  {
    featureType: 'landscape.natural',
    elementType: 'geometry.fill',
    stylers: [{ color: '#e4ecd8' }],
  },

  // === ROADS ===
  // Hide road labels
  {
    featureType: 'road',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },
  // All roads — warm cream-peach fill, gender-neutral
  {
    featureType: 'road',
    elementType: 'geometry.fill',
    stylers: [{ color: '#f5e6d0' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry.stroke',
    stylers: [{ visibility: 'off' }],
  },
  // Local roads — nice thick presence
  {
    featureType: 'road.local',
    elementType: 'geometry',
    stylers: [{ weight: 1.5 }],
  },
  // Arterial roads — slightly thicker
  {
    featureType: 'road.arterial',
    elementType: 'geometry',
    stylers: [{ weight: 2 }],
  },
  // Show arterial labels — warm taupe text
  {
    featureType: 'road.arterial',
    elementType: 'labels',
    stylers: [{ visibility: 'on' }],
  },
  {
    featureType: 'road.arterial',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#baa898' }],
  },
  {
    featureType: 'road.arterial',
    elementType: 'labels.text.stroke',
    stylers: [{ color: '#faf3e0' }, { weight: 3 }],
  },
  // Highways — same pink, just a touch thicker
  {
    featureType: 'road.highway',
    elementType: 'geometry',
    stylers: [{ weight: 2.5 }],
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry.fill',
    stylers: [{ color: '#f5e6d0' }],
  },

  // === WATER — dreamy periwinkle blue ===
  {
    featureType: 'water',
    elementType: 'geometry.fill',
    stylers: [{ color: '#b8d4f0' }],
  },
  {
    featureType: 'water',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },

  // === TRANSIT — hidden ===
  {
    featureType: 'transit',
    stylers: [{ visibility: 'off' }],
  },
];
