// Vercel entry: the whole Express app is one serverless function (see vercel.json rewrites).
// `npm run build` compiles src/ to dist/ before this is bundled.
import { createApp } from "../dist/app.js";

export default createApp({ stateless: true });
