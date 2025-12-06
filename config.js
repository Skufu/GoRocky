// Client runtime configuration for API calls.
// Static deploy uses a separate backend origin; point directly to the API host.
// Update these values at deploy time (e.g., Render env inject) to control
// the API base, default model, and enabled models. Keys are optional; leave
// them blank to require user entry.
window.__APP_CONFIG = window.__APP_CONFIG || {
    apiBaseUrl: 'https://gorocky-api.onrender.com',
    defaultModel: 'openai', // options: mock | gemini | openai
    models: {
        mock: true,
        gemini: true,
        openai: true
    },
    modelKeys: {
        gemini: '', // set from GEMINI_API_KEY at deploy if desired
        openai: ''  // set from OPENAI_API_KEY at deploy if desired
    }
};

