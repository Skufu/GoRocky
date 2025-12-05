// Client runtime configuration for API calls.
// Override window.__APP_CONFIG.apiBaseUrl at deploy time if the backend is on another origin.
window.__APP_CONFIG = window.__APP_CONFIG || {
    apiBaseUrl: window.location.origin || 'http://localhost:8080'
};

