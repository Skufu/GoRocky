// Client runtime configuration for API calls.
// Static deploy uses a separate backend origin; point directly to the API host.
// Update these values at deploy time (e.g., Render env inject) to control
// the API base, default model, and enabled models. LLM calls are proxied
// through the backend; keys stay server-side.
window.__APP_CONFIG = window.__APP_CONFIG || {
    apiBaseUrl: 'https://gocare-backend.onrender.com',
    defaultModel: 'openai', // options: mock | gemini | openai
    models: {
        mock: true,
        gemini: true,
        openai: true
    }
};

