# AgentLog v2.0 Changelog

## Major Changes: Provider-Key-Based Authentication

Removed the AgentLog API key concept. Users now authenticate directly with their provider keys (OpenAI, Anthropic, Google, xAI).

### Backend (index.js)

**New:**
- `accounts` table storing key hashes (SHA256) with provider info
- `POST /api/account/lookup` - Creates/looks up accounts by key hash
- Provider key detection from prefixes:
  - `sk-` (not `sk-ant-`) → OpenAI
  - `sk-ant-` → Anthropic  
  - `AIza` → Google/Gemini
  - `xai-` → xAI/Grok
- Universal proxy now accepts provider key directly in Authorization header
- Automatic account creation on first use

**Updated:**
- All authenticated endpoints support both legacy AgentLog keys AND provider keys
- Tasks now linked to `account_id` instead of just `api_key_id`
- Proxy no longer requires `X-Provider-Key` header - just use your normal key

**Kept for backward compatibility:**
- `api_keys` table and legacy key validation
- Old demo key endpoint `/api/key`

### Mobile App (App.tsx)

**New Onboarding Flow:**
- Provider cards for OpenAI, Anthropic, Google Gemini, xAI Grok
- Each card shows:
  - Provider icon and name
  - API key input field
  - "Get Key" link to provider's dashboard
  - Connect button with testing
  - Connected status indicator
- Continue requires at least 1 connected provider

**Dashboard:**
- Shows proxy URL prominently (tap to copy)
- Integration guide screen with code examples
- Python, JavaScript, and Anthropic examples

**Settings:**
- Manage provider keys (add/remove)
- View connected providers
- Failure alerts toggle
- Reset all data option

### How It Works Now

1. **User enters OpenAI key** in the app
2. **App hashes key (SHA256)** and calls `/api/account/lookup`
3. **Backend creates account** if new (stores hash, not raw key)
4. **App stores raw key locally** (AsyncStorage) for proxy use
5. **When using proxy**, user passes key directly in Authorization header
6. **Proxy detects provider** from key prefix, forwards to correct API
7. **Tasks logged** under the account (identified by key hash)

### Usage

```javascript
// Just use your normal API key - we detect the provider automatically
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'https://agentlog-api.fly.dev/v1',
  apiKey: 'sk-your-openai-key'  // Your real key
});

// All calls tracked under your account (identified by key hash)
const response = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### Files Modified
- `agentlog-api/index.js` - Backend with new account system
- `agentlog-mobile/App.tsx` - Complete UI rewrite
- `agentlog-mobile/package.json` - Added expo-crypto, fixed name
