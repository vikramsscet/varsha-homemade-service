'use strict';

const errorResponse = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const cartOk = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/CartResponse' } } },
});
const cartAuth = [{ bearerAuth: [] }, { anonymousCartId: [] }];
const cartIdParam = { name: 'cartId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const itemIdParam = { name: 'itemId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const cartErrors = {
  400: errorResponse('Invalid request or X-Anonymous-Cart-ID'),
  401: errorResponse('Missing or invalid credentials'),
  404: errorResponse('Cart not found (or not owned by the caller)'),
  409: errorResponse('Cart is not ACTIVE'),
};

const addressAuth = [{ bearerAuth: [] }];
const addressIdParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const addressOk = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/AddressResponse' } } },
});
const addressExample = {
  firstName: 'Vikram', lastName: 'Rao', phone: '+918319510666', country: 'India',
  addressLine1: 'Beverly Hills Society', addressLine2: 'Building A, Flat 101',
  city: 'Pune', state: 'Maharashtra', postalCode: '411057', isDefault: true,
};
const addressBody = (ref) => ({
  required: true,
  content: { 'application/json': { schema: { $ref: ref }, example: addressExample } },
});
const addressRules =
  ' Validation: firstName/lastName/city/state max 100, addressLine1/2 max 255, phone 6-20 chars (digits, optional leading +, spaces, ().-), postalCode 2-20 alphanumeric/space/hyphen, country = name or ISO alpha-2 code. Errors: INVALID_REQUEST (400, `details[]` lists fields), UNAUTHORIZED (401), ADDRESS_NOT_FOUND (404), INVALID_ADDRESS (400), ADDRESS_LIMIT_REACHED (409).';
const addressErrors = {
  400: errorResponse('Invalid request'),
  401: errorResponse('Missing or invalid token'),
  404: errorResponse('ADDRESS_NOT_FOUND (missing or not owned by the caller)'),
};

const guestAuth = [{ guestCheckoutSession: [] }];
const guestOk = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/GuestCheckoutResponse' } } },
});
const guestRules =
  ' Errors: INVALID_GUEST_SESSION (missing/malformed token), GUEST_SESSION_NOT_FOUND (unknown or deleted), GUEST_SESSION_EXPIRED (all 401); INVALID_REQUEST (400); INVALID_CHECKOUT_DETAILS (400).';
const guestErrors = {
  401: errorResponse('INVALID_GUEST_SESSION, GUEST_SESSION_NOT_FOUND or GUEST_SESSION_EXPIRED'),
};

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'user-and-cart-service',
    version: '1.0.0',
    description: 'User, authentication and cart API for varsha-homemade.com',
  },
  servers: [{ url: 'http://localhost:3001' }],
  tags: [{ name: 'Auth' }, { name: 'Addresses' }, { name: 'Guest Checkout' }, { name: 'Cart' }, { name: 'Cart Items' }, { name: 'Orders' }, { name: 'Payments' }, { name: 'Health' }],
  paths: {
    '/api/v1/auth/google': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in with a Google ID token',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['credential'],
                properties: { credential: { type: 'string', description: 'Google ID token' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Login successful',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResponse' } } },
          },
          400: errorResponse('Invalid request'),
          401: errorResponse('Invalid Google credential'),
          403: errorResponse('Account disabled'),
          429: errorResponse('Rate limited'),
        },
      },
    },
    '/api/v1/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Current user profile',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Profile',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/UserResponse' } } },
          },
          401: errorResponse('Missing or invalid token'),
          404: errorResponse('User not found'),
        },
      },
    },
    '/api/v1/addresses': {
      get: {
        tags: ['Addresses'],
        summary: 'List the caller\'s addresses (default first, then most recently updated)',
        security: addressAuth,
        responses: {
          200: {
            description: 'Addresses (empty list if none)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AddressListResponse' } } },
          },
          401: addressErrors[401],
        },
      },
      post: {
        tags: ['Addresses'],
        summary: 'Create an address (the first address becomes the default)',
        description: 'Requires a Bearer JWT; the owner is always the token subject.' + addressRules,
        security: addressAuth,
        requestBody: addressBody('#/components/schemas/AddressInput'),
        responses: {
          201: addressOk('Created'),
          400: addressErrors[400],
          401: addressErrors[401],
          409: errorResponse('ADDRESS_LIMIT_REACHED (20 per user)'),
        },
      },
    },
    '/api/v1/addresses/{id}': {
      get: {
        tags: ['Addresses'],
        summary: 'Get one address',
        security: addressAuth,
        parameters: [addressIdParam],
        responses: { 200: addressOk('Address'), ...addressErrors },
      },
      put: {
        tags: ['Addresses'],
        summary: 'Replace an address (isDefault optional; the default cannot be unset directly)',
        description: 'Full replacement of editable fields. Sending isDefault=false for the current default returns INVALID_ADDRESS.' + addressRules,
        security: addressAuth,
        parameters: [addressIdParam],
        requestBody: addressBody('#/components/schemas/AddressInput'),
        responses: { 200: addressOk('Updated'), ...addressErrors },
      },
      delete: {
        tags: ['Addresses'],
        summary: 'Delete an address (promotes another to default if the default was deleted)',
        security: addressAuth,
        parameters: [addressIdParam],
        responses: { 200: { description: 'Deleted' }, ...addressErrors },
      },
    },
    '/api/v1/addresses/{id}/default': {
      patch: {
        tags: ['Addresses'],
        summary: 'Set an address as the default',
        description: 'Unsets the previous default atomically. No request body.',
        security: addressAuth,
        parameters: [addressIdParam],
        responses: { 200: addressOk('Updated address'), ...addressErrors },
      },
    },
    '/api/v1/guest-checkout/sessions': {
      post: {
        tags: ['Guest Checkout'],
        summary: 'Create a guest checkout session',
        description:
          'Rate limited per IP. Always creates a new session. `sessionToken` is returned once and only its SHA-256 hash is stored. `anonymousCartId` (optional) is the anonymous cart id the client holds; it is only used to link the session to that ACTIVE cart and is never accepted as a credential.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { anonymousCartId: { type: 'string', format: 'uuid' } },
              },
            },
          },
        },
        responses: {
          201: guestOk('Created (includes sessionToken, shown once)'),
          400: errorResponse('Invalid request'),
          404: errorResponse('CART_NOT_FOUND'),
          429: errorResponse('Rate limited'),
        },
      },
    },
    '/api/v1/guest-checkout/sessions/current': {
      get: {
        tags: ['Guest Checkout'],
        summary: 'Get the current guest checkout session',
        description: 'Authenticated only by the X-Guest-Checkout-Session header (not by JWT or cart id).' + guestRules,
        security: guestAuth,
        responses: { 200: guestOk('Session'), 401: guestErrors[401] },
      },
      put: {
        tags: ['Guest Checkout'],
        summary: 'Save customer and/or delivery details (partial updates supported)',
        description: 'Only the provided fields change. Ownership and expiry cannot be modified (unknown fields are ignored). Rules: email valid, max 320; names/city/state max 100; addressLine max 255; phone and postalCode as for addresses; country = name or ISO alpha-2 code.' + guestRules,
        security: guestAuth,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/GuestCheckoutDetails' },
              example: {
                customer: { email: 'customer@example.com', firstName: 'Vikram', lastName: 'Rao', phone: '+918319510666' },
                deliveryAddress: {
                  country: 'India', addressLine1: 'Beverly Hills Society', addressLine2: 'Building A, Flat 101',
                  city: 'Pune', state: 'Maharashtra', postalCode: '411057',
                },
              },
            },
          },
        },
        responses: { 200: guestOk('Updated session'), 400: errorResponse('Invalid request'), 401: guestErrors[401] },
      },
      delete: {
        tags: ['Guest Checkout'],
        summary: 'Delete the session (the cart is not deleted)',
        security: guestAuth,
        responses: { 200: { description: 'Deleted' }, 401: guestErrors[401] },
      },
    },
    '/api/v1/carts': {
      post: {
        tags: ['Cart'],
        summary: 'Create a cart (or return the existing ACTIVE cart)',
        description:
          'With a Bearer token the cart belongs to the user. Without one, it is anonymous: send X-Anonymous-Cart-ID, or omit it and a new id is returned in the response body (`anonymousId`) and the X-Anonymous-Cart-ID response header.',
        security: [{}, ...cartAuth],
        parameters: [{ $ref: '#/components/parameters/AnonymousCartId' }],
        responses: { 200: cartOk('Existing ACTIVE cart'), 201: cartOk('Cart created'), 400: cartErrors[400], 401: cartErrors[401] },
      },
    },
    '/api/v1/carts/current': {
      get: {
        tags: ['Cart'],
        summary: "The caller's ACTIVE cart",
        security: cartAuth,
        parameters: [{ $ref: '#/components/parameters/AnonymousCartId' }],
        responses: { 200: cartOk('Cart'), 400: cartErrors[400], 401: cartErrors[401], 404: cartErrors[404] },
      },
    },
    '/api/v1/carts/{cartId}': {
      get: {
        tags: ['Cart'],
        summary: 'Get a cart',
        security: cartAuth,
        parameters: [cartIdParam, { $ref: '#/components/parameters/AnonymousCartId' }],
        responses: { 200: cartOk('Cart'), 400: cartErrors[400], 401: cartErrors[401], 404: cartErrors[404] },
      },
      delete: {
        tags: ['Cart'],
        summary: 'Delete an ACTIVE cart and its items',
        security: cartAuth,
        parameters: [cartIdParam, { $ref: '#/components/parameters/AnonymousCartId' }],
        responses: { 200: { description: 'Deleted' }, ...cartErrors },
      },
    },
    '/api/v1/carts/{cartId}/merge': {
      post: {
        tags: ['Cart'],
        summary: 'Merge an anonymous cart into the logged-in user cart',
        description:
          'Requires BOTH the Bearer token and the X-Anonymous-Cart-ID that owns `cartId`. Same product in both carts: quantities are added (capped at the per-item maximum). The anonymous cart becomes ABANDONED. Runs in one transaction.',
        security: [{ bearerAuth: [], anonymousCartId: [] }],
        parameters: [cartIdParam, { $ref: '#/components/parameters/AnonymousCartId' }],
        responses: { 200: cartOk('Merged user cart'), ...cartErrors, 422: errorResponse('Cart item limit exceeded') },
      },
    },
    '/api/v1/carts/{cartId}/items': {
      post: {
        tags: ['Cart Items'],
        summary: 'Add a product (quantity is added if already in the cart)',
        description: 'Name, slug and price are fetched from the Product CMS. Any price/total fields in the body are ignored.',
        security: cartAuth,
        parameters: [cartIdParam, { $ref: '#/components/parameters/AnonymousCartId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['productId'],
                properties: {
                  productId: { type: 'string', format: 'uuid', example: '11111111-1111-4111-8111-111111111111' },
                  quantity: { type: 'integer', minimum: 1, default: 1, example: 2 },
                },
              },
            },
          },
        },
        responses: {
          200: cartOk('Existing item quantity increased'),
          201: cartOk('Item added'),
          ...cartErrors,
          404: errorResponse('Cart not found, or product not found / not PUBLISHED / unavailable (PRODUCT_NOT_FOUND)'),
          422: errorResponse('Quantity or item limit exceeded, or product currency is not INR (PRODUCT_CURRENCY_UNSUPPORTED)'),
          502: errorResponse('Product service unavailable'),
        },
      },
      delete: {
        tags: ['Cart Items'],
        summary: 'Remove all items (clear cart)',
        security: cartAuth,
        parameters: [cartIdParam, { $ref: '#/components/parameters/AnonymousCartId' }],
        responses: { 200: cartOk('Empty cart'), ...cartErrors },
      },
    },
    '/api/v1/carts/{cartId}/items/{itemId}': {
      patch: {
        tags: ['Cart Items'],
        summary: 'Set the quantity of an item',
        security: cartAuth,
        parameters: [cartIdParam, itemIdParam, { $ref: '#/components/parameters/AnonymousCartId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['quantity'],
                properties: { quantity: { type: 'integer', minimum: 1, example: 3 } },
              },
            },
          },
        },
        responses: { 200: cartOk('Updated cart'), ...cartErrors },
      },
      delete: {
        tags: ['Cart Items'],
        summary: 'Remove one item',
        security: cartAuth,
        parameters: [cartIdParam, itemIdParam, { $ref: '#/components/parameters/AnonymousCartId' }],
        responses: { 200: cartOk('Updated cart'), ...cartErrors },
      },
    },
    '/api/v1/orders': {
      post: {
        tags: ['Orders'],
        summary: 'Create an internal order from the caller\'s active cart',
        description:
          'Authenticated customers send `Authorization: Bearer <jwt>` and `addressId` (a saved address they own); the cart is their ACTIVE cart. Guests send `X-Guest-Checkout-Session`; the cart, contact and delivery details come from the session (it must be linked to a cart and complete). Prices are re-fetched from the Product CMS and discount, tax, delivery and total are computed on the server; any amount sent by the client is ignored. The cart is NOT cleared.\n\nDuplicate protection: a cart has at most one open order. Repeating the request for an unchanged cart returns the existing order (200); a changed cart cancels the old open order and creates a new one (201). `Idempotency-Key` makes retries return the original order. For guests, `guestAccessToken` is returned once on creation (store it to retry payment after the session expires).\n\nErrors: UNAUTHORIZED / INVALID_GUEST_SESSION (401), INVALID_REQUEST, ADDRESS_REQUIRED, INVALID_IDEMPOTENCY_KEY (400), ADDRESS_NOT_FOUND, CART_NOT_FOUND (404), CART_EMPTY, ORDER_TOTAL_INVALID, CHECKOUT_DETAILS_INCOMPLETE, GUEST_SESSION_HAS_NO_CART (422), PRODUCT_UNAVAILABLE, CART_CHANGED, CART_NOT_ACTIVE, CART_ALREADY_ORDERED, PAYMENT_IN_PROGRESS (409), PRODUCT_SERVICE_UNAVAILABLE (502).',
        security: [{ bearerAuth: [] }, { guestCheckoutSession: [] }],
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{8,64}$' } },
        ],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { addressId: { type: 'string', format: 'uuid', description: 'Required for authenticated customers; ignored for guests.' } },
              },
              example: { addressId: '5b2f6c0e-7a53-4c36-9a1e-0d2f4a8f1b11' },
            },
          },
        },
        responses: {
          201: { description: 'Order created', content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderResponse' } } } },
          200: { description: 'Existing open order / idempotent replay', content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderResponse' } } } },
          400: errorResponse('Invalid request'),
          401: errorResponse('Missing or invalid credentials'),
          404: errorResponse('Address or cart not found'),
          409: errorResponse('Product unavailable, cart changed or already ordered'),
          422: errorResponse('Empty cart or incomplete checkout details'),
          429: errorResponse('RATE_LIMITED'),
          502: errorResponse('Product service unavailable'),
        },
      },
    },
    '/api/v1/payments/create-order': {
      post: {
        tags: ['Payments'],
        summary: 'Create (or return) the Razorpay order for an internal order',
        description:
          'Creates a Razorpay order for the amount stored on the internal order (never a client amount) and records a payment attempt plus an audit ledger entry. Calling again while an attempt is open returns the same Razorpay order (200, `reused: true`); after a failed attempt a new attempt is created. Concurrent calls are serialised per order. The response contains the public key id only; the key secret is never returned. Payment verification and webhooks are not part of this endpoint.\n\nAuthenticate as the order owner with Bearer JWT, `X-Guest-Checkout-Session`, or `X-Guest-Order-Token`. Someone else\'s order is reported as ORDER_NOT_FOUND.\n\nErrors: UNAUTHORIZED / INVALID_GUEST_SESSION / INVALID_GUEST_ORDER_TOKEN (401), INVALID_REQUEST (400), ORDER_NOT_FOUND (404), ORDER_ALREADY_PAID, ORDER_NOT_PAYABLE, ORDER_EXPIRED, PAYMENT_IN_PROGRESS (409), PAYMENT_GATEWAY_ERROR / PAYMENT_GATEWAY_UNAVAILABLE (502), PAYMENT_GATEWAY_NOT_CONFIGURED (503).',
        security: [{ bearerAuth: [] }, { guestCheckoutSession: [] }, { guestOrderToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', format: 'uuid' } } },
              example: { orderId: '0c9d5f8e-1b7a-4d0e-8e57-3a6f2b9c4d10' },
            },
          },
        },
        responses: {
          201: { description: 'Payment order created', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentOrderResponse' } } } },
          200: { description: 'Existing open payment order returned', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentOrderResponse' } } } },
          400: errorResponse('Invalid request'),
          401: errorResponse('Missing or invalid credentials'),
          404: errorResponse('ORDER_NOT_FOUND (missing or not owned by the caller)'),
          409: errorResponse('Order already paid / not payable / expired / payment in progress'),
          429: errorResponse('RATE_LIMITED'),
          502: errorResponse('Payment gateway error'),
          503: errorResponse('Payment gateway not configured'),
        },
      },
    },
    '/api/v1/payments/verify': {
      post: {
        tags: ['Payments'],
        summary: 'Verify a Razorpay checkout result and settle the order',
        description:
          'Call after Razorpay Checkout returns `razorpay_order_id`, `razorpay_payment_id` and `razorpay_signature`. Nothing from the browser is trusted as proof of payment: the Razorpay order id must match the stored payment, the signature is verified server-side (HMAC-SHA256 of `order_id|payment_id` with the key secret), and the payment is then fetched from Razorpay; only a *captured* payment with the exact stored amount and currency marks the payment CAPTURED and the order PAID (once; the cart is set to COMPLETED).\n\nIdempotent: repeating the request for a settled payment returns 200 with `alreadyProcessed: true` and makes no gateway call. Concurrent requests are serialised by row locks.\n\nCaller must own the order (Bearer JWT, `X-Guest-Checkout-Session`, or `X-Guest-Order-Token`); an unknown or foreign `internalPaymentId` is PAYMENT_NOT_FOUND.\n\nOutcomes: 200 paid (or already processed); 202 signature valid but not captured yet (`paid: false`, status AUTHORIZED or PENDING; poll again or wait for the webhook phase); 402 PAYMENT_FAILED (payment marked FAILED, order PAYMENT_FAILED and retryable via create-order).\n\nErrors: INVALID_REQUEST, RAZORPAY_ORDER_MISMATCH, INVALID_SIGNATURE (400); UNAUTHORIZED / INVALID_GUEST_SESSION / INVALID_GUEST_ORDER_TOKEN (401); PAYMENT_NOT_FOUND (404); PAYMENT_ALREADY_PROCESSED, PAYMENT_MISMATCH, PAYMENT_REFUNDED, ORDER_ALREADY_PAID, ORDER_NOT_PAYABLE, PAYMENT_NOT_VERIFIABLE, PAYMENT_CONFLICT (409); PAYMENT_GATEWAY_* (502); PAYMENT_GATEWAY_NOT_CONFIGURED (503).',
        security: [{ bearerAuth: [] }, { guestCheckoutSession: [] }, { guestOrderToken: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['internalPaymentId', 'razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'],
                properties: {
                  internalPaymentId: { type: 'string', format: 'uuid' },
                  razorpay_order_id: { type: 'string', example: 'order_Q1w2e3r4t5y6' },
                  razorpay_payment_id: { type: 'string', example: 'pay_Q1w2e3r4t5y6' },
                  razorpay_signature: { type: 'string', description: '64-char hex HMAC from Razorpay Checkout' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Payment verified and order PAID (or already processed)', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentVerifyResponse' } } } },
          202: { description: 'Signature valid but payment not captured yet (paid: false)', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentVerifyResponse' } } } },
          400: errorResponse('Invalid request, RAZORPAY_ORDER_MISMATCH or INVALID_SIGNATURE'),
          401: errorResponse('Missing or invalid credentials'),
          402: errorResponse('PAYMENT_FAILED'),
          404: errorResponse('PAYMENT_NOT_FOUND (unknown or not owned by the caller)'),
          409: errorResponse('Mismatch, already processed, refunded or order not payable'),
          429: errorResponse('RATE_LIMITED'),
          502: errorResponse('Payment gateway error'),
          503: errorResponse('Payment gateway not configured'),
        },
      },
    },
    '/api/v1/payments/webhook': {
      post: {
        tags: ['Payments'],
        summary: 'Razorpay webhook receiver (server-to-server)',
        description:
          'Called by Razorpay, not by the browser. Authenticity is the `X-Razorpay-Signature` header: HMAC-SHA256 (hex) of the **raw request body bytes** with `RAZORPAY_WEBHOOK_SECRET`. Invalid or missing signatures get 400 and nothing is stored. Supported events: `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`; other signed events are stored and ignored.\n\nVerified events are stored in `payment_webhook_events` (customer PII removed) keyed by `X-Razorpay-Event-Id`, so redeliveries are detected. Processing is independent of the frontend `/verify` call and shares its state machine: transitions are monotonic (a late `authorized` or an older attempt\'s `failed` never undoes a capture), the order is confirmed exactly once and the cart is completed in the same transaction.\n\nResponses: 200 `PROCESSED` | `IGNORED` (unknown order, unsupported/stale event, amount mismatch) | `DUPLICATE` | `ABANDONED` (stopped after 10 failed attempts); 400 INVALID_WEBHOOK_SIGNATURE / INVALID_WEBHOOK_PAYLOAD; 409 IN_PROGRESS (same event is being processed; Razorpay retries); 500 WEBHOOK_PROCESSING_FAILED (transient; event kept FAILED and reprocessed on redelivery); 503 PAYMENT_WEBHOOK_NOT_CONFIGURED.',
        parameters: [
          { name: 'X-Razorpay-Signature', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'X-Razorpay-Event-Id', in: 'header', required: false, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', description: 'Razorpay event envelope, signed as sent.' },
              example: { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_Q1w2e3r4t5y6', order_id: 'order_Q1w2e3r4t5y6', amount: 109750, currency: 'INR', status: 'captured' } } } },
            },
          },
        },
        responses: {
          200: { description: 'Received', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { received: { type: 'boolean' }, status: { type: 'string', enum: ['PROCESSED', 'IGNORED', 'DUPLICATE', 'ABANDONED'] } } } } } } } },
          400: errorResponse('INVALID_WEBHOOK_SIGNATURE or INVALID_WEBHOOK_PAYLOAD'),
          409: errorResponse('IN_PROGRESS: same event is being processed; retry later'),
          500: errorResponse('WEBHOOK_PROCESSING_FAILED (transient)'),
          503: errorResponse('PAYMENT_WEBHOOK_NOT_CONFIGURED'),
        },
      },
    },
    '/health': {
      get: { tags: ['Health'], summary: 'Liveness', responses: { 200: { description: 'UP' } } },
    },
    '/health/db': {
      get: {
        tags: ['Health'],
        summary: 'Database connectivity',
        responses: { 200: { description: 'UP' }, 503: errorResponse('Database unavailable') },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      anonymousCartId: { type: 'apiKey', in: 'header', name: 'X-Anonymous-Cart-ID' },
      guestCheckoutSession: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Guest-Checkout-Session',
        description: 'Token returned once by POST /api/v1/guest-checkout/sessions. Independent of bearerAuth and of the anonymous cart id.',
      },
      guestOrderToken: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Guest-Order-Token',
        description: 'Returned once as `guestAccessToken` when a guest order is created. Accepted only by POST /payments/create-order.',
      },
    },
    parameters: {
      AnonymousCartId: {
        name: 'X-Anonymous-Cart-ID',
        in: 'header',
        required: false,
        description: 'Anonymous customer id (UUID). Ignored when a Bearer token is sent.',
        schema: { type: 'string', format: 'uuid' },
      },
    },
    schemas: {
      PaymentVerifyResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: {
            type: 'object',
            properties: {
              paymentId: { type: 'string', format: 'uuid' },
              orderId: { type: 'string', format: 'uuid' },
              orderNumber: { type: 'string' },
              razorpayOrderId: { type: 'string' },
              razorpayPaymentId: { type: 'string', nullable: true },
              paymentStatus: { type: 'string', enum: ['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED'] },
              orderStatus: { type: 'string', example: 'PAID' },
              paid: { type: 'boolean' },
              alreadyProcessed: { type: 'boolean' },
              amount: { type: 'integer', description: 'paise' },
              currency: { type: 'string', example: 'INR' },
            },
          },
          message: { type: 'string', example: 'Payment verified' },
        },
      },
      OrderItem: {
        type: 'object',
        properties: {
          productId: { type: 'string', format: 'uuid' },
          productName: { type: 'string' },
          productSlug: { type: 'string' },
          unitPrice: { type: 'number', example: 249 },
          quantity: { type: 'integer', example: 2 },
          totalPrice: { type: 'number', example: 498 },
        },
      },
      Order: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          orderNumber: { type: 'string', example: 'VH261106-100001' },
          status: { type: 'string', enum: ['PENDING_PAYMENT', 'PAYMENT_FAILED', 'PAID', 'CANCELLED', 'EXPIRED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
          customerType: { type: 'string', enum: ['USER', 'GUEST'] },
          cartId: { type: 'string', format: 'uuid', nullable: true },
          currency: { type: 'string', example: 'INR' },
          subtotal: { type: 'number' },
          discountAmount: { type: 'number' },
          taxAmount: { type: 'number' },
          shippingAmount: { type: 'number' },
          totalAmount: { type: 'number', example: 1097.5 },
          amountInPaise: { type: 'integer', example: 109750 },
          customer: { type: 'object', properties: { email: { type: 'string' }, phone: { type: 'string', nullable: true } } },
          shippingAddress: { type: 'object' },
          items: { type: 'array', items: { $ref: '#/components/schemas/OrderItem' } },
          paymentExpiresAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          guestAccessToken: { type: 'string', description: 'Guests only, only on the response that creates the order.' },
        },
      },
      OrderResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { $ref: '#/components/schemas/Order' },
          message: { type: 'string', example: 'Order created' },
        },
      },
      PaymentOrderResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: {
            type: 'object',
            properties: {
              orderId: { type: 'string', format: 'uuid' },
              paymentId: { type: 'string', format: 'uuid' },
              attemptNumber: { type: 'integer', example: 1 },
              razorpayOrderId: { type: 'string', example: 'order_Q1w2e3r4t5y6' },
              razorpayKeyId: { type: 'string', example: 'rzp_test_xxxxxxxxxxxxxx' },
              amount: { type: 'integer', description: 'Amount in paise', example: 109750 },
              currency: { type: 'string', example: 'INR' },
              status: { type: 'string', example: 'CREATED' },
              reused: { type: 'boolean' },
            },
          },
          message: { type: 'string', example: 'Payment order created' },
        },
      },
      GuestCheckoutDetails: {
        type: 'object',
        properties: {
          customer: {
            type: 'object',
            properties: {
              email: { type: 'string', format: 'email', example: 'customer@example.com' },
              firstName: { type: 'string', example: 'Vikram' },
              lastName: { type: 'string', example: 'Rao' },
              phone: { type: 'string', example: '+918319510666' },
            },
          },
          deliveryAddress: {
            type: 'object',
            properties: {
              country: { type: 'string', description: 'Country name or ISO alpha-2 code', example: 'India' },
              addressLine1: { type: 'string' },
              addressLine2: { type: 'string', nullable: true },
              city: { type: 'string' },
              state: { type: 'string' },
              postalCode: { type: 'string', example: '411057' },
            },
          },
        },
      },
      GuestCheckoutResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: {
            allOf: [
              { $ref: '#/components/schemas/GuestCheckoutDetails' },
              {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  sessionToken: { type: 'string', description: 'Only in the create response' },
                  cartId: { type: 'string', format: 'uuid', nullable: true },
                  isComplete: { type: 'boolean' },
                  expiresAt: { type: 'string', format: 'date-time' },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              },
            ],
          },
          message: { type: 'string' },
        },
      },
      AddressInput: {
        type: 'object',
        required: ['firstName', 'lastName', 'phone', 'country', 'addressLine1', 'city', 'state', 'postalCode'],
        properties: {
          firstName: { type: 'string', example: 'Vikram' },
          lastName: { type: 'string', example: 'Rao' },
          phone: { type: 'string', example: '+918319510666' },
          country: { type: 'string', description: 'Country name or ISO 3166-1 alpha-2 code', example: 'India' },
          addressLine1: { type: 'string', example: 'Beverly Hills Society' },
          addressLine2: { type: 'string', nullable: true, example: 'Building A, Flat 101' },
          city: { type: 'string', example: 'Pune' },
          state: { type: 'string', example: 'Maharashtra' },
          postalCode: { type: 'string', example: '411057' },
          isDefault: { type: 'boolean', example: true },
        },
      },
      Address: {
        allOf: [
          { $ref: '#/components/schemas/AddressInput' },
          {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              country: { type: 'string', description: 'ISO alpha-2 code', example: 'IN' },
              countryName: { type: 'string', example: 'India' },
              isDefault: { type: 'boolean' },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
        ],
      },
      AddressResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { $ref: '#/components/schemas/Address' },
          message: { type: 'string', example: 'Success' },
        },
      },
      AddressListResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { type: 'array', items: { $ref: '#/components/schemas/Address' } },
          message: { type: 'string', example: 'Success' },
        },
      },
      CartItem: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          productId: { type: 'string', format: 'uuid' },
          productName: { type: 'string' },
          productSlug: { type: 'string' },
          unitPrice: { type: 'number', example: 249 },
          quantity: { type: 'integer', example: 2 },
          totalPrice: { type: 'number', example: 498 },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Cart: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          ownerType: { type: 'string', enum: ['USER', 'ANONYMOUS'] },
          userId: { type: 'string', format: 'uuid', nullable: true },
          anonymousId: { type: 'string', format: 'uuid', description: 'Only on create, for anonymous carts' },
          status: { type: 'string', enum: ['ACTIVE', 'COMPLETED', 'ABANDONED', 'EXPIRED'] },
          currency: { type: 'string', example: 'INR' },
          subtotal: { type: 'number', example: 498 },
          discountAmount: { type: 'number', example: 0 },
          taxAmount: { type: 'number', example: 0 },
          totalAmount: { type: 'number', example: 498 },
          itemCount: { type: 'integer', example: 2 },
          items: { type: 'array', items: { $ref: '#/components/schemas/CartItem' } },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      CartResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { $ref: '#/components/schemas/Cart' },
          message: { type: 'string', example: 'Success' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'INVALID_REQUEST' },
              message: { type: 'string', example: 'Invalid request' },
            },
          },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          firstName: { type: 'string', nullable: true },
          lastName: { type: 'string', nullable: true },
          displayName: { type: 'string', nullable: true },
          profileImageUrl: { type: 'string', nullable: true },
          emailVerified: { type: 'boolean' },
          status: { type: 'string', example: 'ACTIVE' },
          lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      UserResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { $ref: '#/components/schemas/User' },
          message: { type: 'string', example: 'Success' },
        },
      },
      LoginResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              tokenType: { type: 'string', example: 'Bearer' },
              expiresIn: { type: 'string', example: '7d' },
              user: { $ref: '#/components/schemas/User' },
            },
          },
          message: { type: 'string', example: 'Login successful' },
        },
      },
    },
  },
};
