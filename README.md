# user-and-cart-service

Backend microservice for varsha-homemade.com. **Phases done: User & Authentication** (Google OAuth 2.0 → application JWT) and **Cart**. Next: Checkout.

Stack: Node.js, Express, PostgreSQL (`pg`), JWT, Google OAuth 2.0. Plain JavaScript.

## Run locally

1. Prerequisites: Node 18+, PostgreSQL 13+.
2. Create the database: `createdb varsha_homemade`
3. `npm install`
4. `cp .env.example .env` and fill in `DATABASE_URL`, `JWT_SECRET` (>= 32 chars), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
   Generate a secret: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
5. `npm run migrate`
6. `npm run dev` (or `npm start`) → http://localhost:3001

Swagger UI: http://localhost:3001/api-docs (disabled in production unless `ENABLE_DOCS=true`).

## Structure

```
src/
  app.js, server.js
  config/      env, database (pg pool), google (ID-token verification)
  middleware/  auth (JWT), errorHandler, requestLogger (request ID), validate (Joi)
  integrations/product/  ProductServiceClient (mock + http providers)
  modules/
    cart/      routes -> controller -> service (+ pricing, validation) -> repository
    auth/      routes -> controller -> service (+ validation)
    users/     service -> repository (SQL lives only in repositories)
  routes/      index.js (/api/v1), health.routes.js
  utils/       jwt, response, errors
  docs/        openapi.js
migrations/    *.sql applied in order by `npm run migrate`
```


## API

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /api/v1/auth/google | – | Exchange Google ID token for app JWT (rate limited) |
| GET | /api/v1/auth/me | Bearer | Current user profile |
| POST | /api/v1/carts | Bearer or X-Anonymous-Cart-ID (optional) | Create cart, or return the existing ACTIVE one |
| GET | /api/v1/carts/current | Bearer or anon id | Caller's ACTIVE cart |
| GET | /api/v1/carts/:cartId | Bearer or anon id | Get cart |
| DELETE | /api/v1/carts/:cartId | Bearer or anon id | Delete ACTIVE cart |
| POST | /api/v1/carts/:cartId/items | Bearer or anon id | Add product (`productId`, `quantity`) |
| PATCH | /api/v1/carts/:cartId/items/:itemId | Bearer or anon id | Set quantity |
| DELETE | /api/v1/carts/:cartId/items/:itemId | Bearer or anon id | Remove item |
| DELETE | /api/v1/carts/:cartId/items | Bearer or anon id | Clear cart |
| POST | /api/v1/carts/:cartId/merge | Bearer **and** anon id | Merge anonymous cart into user cart |
| GET | /health | – | Liveness |
| GET | /health/db | – | DB connectivity |

Responses: `{ "success": true, "data": {...}, "message": "Success" }` or `{ "success": false, "error": { "code": "...", "message": "..." } }`. Every response carries an `X-Request-Id` header.

JWT payload: `{ "sub": "<user-id>", "email": "<email>", "iat", "exp" }`.

## cURL

```bash
curl http://localhost:3001/health
curl http://localhost:3001/health/db

# Login (get an ID token from Google Sign-In / OAuth Playground, using your client ID)
curl -X POST http://localhost:3001/api/v1/auth/google \
  -H 'Content-Type: application/json' \
  -d '{"credential":"<google-id-token>"}'

# Current user
curl http://localhost:3001/api/v1/auth/me -H "Authorization: Bearer <jwt>"
```

To get a test ID token: https://developers.google.com/oauthplayground → gear icon → "Use your own OAuth credentials" → authorize scopes `openid email profile` → exchange the code; the response contains `id_token`. (The playground's client ID must match `GOOGLE_CLIENT_ID`.)

## Behaviour notes

- Login looks up by `google_id`; if none, links an existing user with the same (Google-verified) email; otherwise creates one. `last_login_at` is updated on each login.
- Only Google-verified emails are accepted. No passwords are stored.
- Users with `status != ACTIVE` get 403.
- Logs contain method, path (no query string), status, duration and request ID only - never headers/bodies.
- Timestamps use `TIMESTAMPTZ`; `updated_at` is maintained by a DB trigger.
- Auth rate limit is in-memory per instance (`AUTH_RATE_LIMIT_*`); use a shared store (e.g. Redis) if you scale horizontally. Set `TRUST_PROXY` correctly behind a proxy.

## Cart

### Identity
- **Authenticated:** `Authorization: Bearer <jwt>`. The cart is owned by `req.user.id`.
- **Anonymous:** `X-Anonymous-Cart-ID: <uuid>`. `POST /carts` without any identity mints one and returns it in the body (`anonymousId`) and the `X-Anonymous-Cart-ID` response header; the client stores it and sends it on every cart call. It acts as a bearer secret, so keep it out of URLs and logs. No `users` row is ever created for anonymous carts.
- A Bearer token wins over the anonymous header; an invalid token is a 401, never a fallback to anonymous.
- A cart that is not yours is reported as `404 CART_NOT_FOUND` (ownership is part of the SQL query, so existence is not leaked).

### Behaviour
- One ACTIVE cart per owner (partial unique indexes); `POST /carts` is idempotent (201 new, 200 existing).
- `carts` has a CHECK that exactly one of `user_id` / `anonymous_id` is set. Anonymous carts expire after `CART_ANONYMOUS_TTL_DAYS` (default 30) and are lazily marked `EXPIRED` on access; user carts do not expire.
- Only ACTIVE carts can be modified (`409 CART_NOT_ACTIVE` otherwise). `DELETE /carts/:id` hard-deletes an ACTIVE cart (items cascade); COMPLETED/ABANDONED/EXPIRED carts are kept.
- **Pricing** (`cart.pricing.js`, integer paise internally): `item total = unit_price × quantity`, `subtotal = Σ item totals`, `total = subtotal − discount + tax`. Prices, names and slugs always come from the Product CMS; `unitPrice`, `totalPrice`, `subtotal`, `totalAmount` in request bodies are ignored. Discount and tax are 0 until those engines exist.
- Adding an existing product increases its quantity and refreshes its price snapshot; `PATCH` sets an absolute quantity and keeps the stored price. Limits: `CART_MAX_ITEM_QUANTITY` (99) per item, `CART_MAX_DISTINCT_ITEMS` (50) per cart (`422`).
- **Merge** (`POST /carts/:anonCartId/merge`, needs the Bearer token and the `X-Anonymous-Cart-ID` that owns the cart): one transaction; creates the user's cart if missing; same product → quantities added (capped at the max); new product → copied; totals recalculated; the anonymous cart becomes `ABANDONED` (re-merge → 409).
- All item mutations lock the cart row (`SELECT … FOR UPDATE`) and recompute totals from the item rows in the same transaction.

### Product CMS
`src/integrations/product` exposes `productServiceClient.getProduct(productId)` → `{ productId, productName, productSlug, unitPrice } | null`.
- `PRODUCT_SERVICE_PROVIDER` is **required** (no default; startup fails if unset, except `NODE_ENV=test`).
- `PRODUCT_SERVICE_PROVIDER=mock` (dev/test only): built-in catalog
  - `11111111-1111-4111-8111-111111111111` Mango Pickle, 249.00
  - `22222222-2222-4222-8222-222222222222` Besan Laddu, 599.50
  - `33333333-3333-4333-8333-333333333333` Masala Chakli, 149.99
- `PRODUCT_SERVICE_PROVIDER=http` + `PRODUCT_SERVICE_URL`: calls `GET {url}/api/v1/products/:id` and maps `id/title/slug/price` to the cart contract. Products that are not `PUBLISHED` or have `isAvailable: false` give `404 PRODUCT_NOT_FOUND`; non-INR products give `422 PRODUCT_CURRENCY_UNSUPPORTED`. Mock is refused in production.

### Cart cURL
```bash
BASE=http://localhost:3001/api/v1
P1=11111111-1111-4111-8111-111111111111

# --- Anonymous ---
curl -si -X POST $BASE/carts                       # note data.id, data.anonymousId (and X-Anonymous-Cart-ID header)
ANON=<anonymousId>; CART=<cart id>
curl -X POST $BASE/carts/$CART/items -H "X-Anonymous-Cart-ID: $ANON" -H 'Content-Type: application/json' \
  -d "{\"productId\":\"$P1\",\"quantity\":2}"
curl $BASE/carts/current        -H "X-Anonymous-Cart-ID: $ANON"
curl $BASE/carts/$CART          -H "X-Anonymous-Cart-ID: $ANON"
curl -X PATCH $BASE/carts/$CART/items/<itemId> -H "X-Anonymous-Cart-ID: $ANON" -H 'Content-Type: application/json' -d '{"quantity":3}'
curl -X DELETE $BASE/carts/$CART/items/<itemId> -H "X-Anonymous-Cart-ID: $ANON"
curl -X DELETE $BASE/carts/$CART/items          -H "X-Anonymous-Cart-ID: $ANON"   # clear
curl -X DELETE $BASE/carts/$CART                -H "X-Anonymous-Cart-ID: $ANON"   # delete

# --- Authenticated ---
JWT=<jwt from /auth/google>
curl -X POST $BASE/carts -H "Authorization: Bearer $JWT"
curl -X POST $BASE/carts/<userCartId>/items -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
  -d "{\"productId\":\"$P1\"}"

# --- Merge after login (anonymous cart -> user cart) ---
curl -X POST $BASE/carts/$CART/merge -H "Authorization: Bearer $JWT" -H "X-Anonymous-Cart-ID: $ANON"
```

### Ready for Checkout
Checkout should: load the cart with `cartService.getCart`, **re-fetch prices from the Product CMS** (cart prices are snapshots), run in one transaction (`db.withTransaction`), and finish with `cartService.markCompleted(cartId, client)`. Mount it at `/api/v1/checkout` in `src/routes/index.js`.
