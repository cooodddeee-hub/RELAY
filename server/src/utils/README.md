# Server utilities

This directory currently contains `safeLogger.js`, which provides safe formatting and structured logging for backend errors.

## `safeLogger.js`

- `sanitizeLogText(value)` converts a value to text, redacts common API keys, JWTs, bearer tokens, authorization/cookie values, password/secret assignments, MongoDB URIs, and URL query strings, then limits the output length.
- `errorDetails(error)` returns a sanitized error name, message, and stack string.
- `logError(operation, error, fields)` writes one JSON error record to `console.error`, with a level, operation label, optional HTTP status, supplied context fields, and sanitized error details.

Example from a server module:

```js
import { logError } from '../utils/safeLogger.js';

try {
  await performOperation();
} catch (error) {
  logError('example.performOperation', error, { projectId: String(projectId) });
}
```

Only pass non-sensitive context fields. The helper sanitizes the error text and operation name; it does not recursively sanitize arbitrary values in `fields`, so callers must not include secrets, credentials, tokens, cookies, or request bodies there.
