import 'dotenv/config';
import app from './src/app.js';
import { connectDatabase } from './src/config/database.js';

const port = Number(process.env.PORT || 5000);
if (process.env.MONGODB_URI) {
  await connectDatabase();
} else if (process.env.NODE_ENV === 'production') {
  throw new Error('MONGODB_URI is required in production');
} else {
  console.warn('MONGODB_URI missing: server starts, but database-backed routes will be unavailable.');
}
app.listen(port, () => console.log(`RELAY API listening on http://localhost:${port}`));
