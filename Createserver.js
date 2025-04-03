import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';

// Load environment variables
dotenv.config();

const app = express();
const port = 8080;

// Load Shopify Credentials
const SHOPIFY_API_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_SHOP_NAME;
const STOREFRONT_API_VERSION = '2023-10';

// Ensure Environment Variables are Loaded
if (!SHOPIFY_API_TOKEN || !SHOPIFY_STORE) {
  console.error("Missing Shopify environment variables! Check .env file.");
  process.exit(1);
}

// Fix CORS Issues
app.use(cors({
  origin: [
    "https://team-gamma-checkout-extension.myshopify.com",
    "https://*.ngrok-free.app",
    "http://localhost:8080",
    "https://efca-49-249-2-6.ngrok-free.app",
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Default Route
app.get('/', (req, res) => {
  res.send('Shopify Discount API is Running!');
});

// Fetch Current Cart Data (to get existing discount codes)
const fetchCartData = async (cartId) => {
  const storefrontEndpoint = `https://${SHOPIFY_STORE}/api/${STOREFRONT_API_VERSION}/graphql.json`;

  const query = `
    query ($cartId: ID!) {
      cart(id: $cartId) {
        id
        discountCodes {
          applicable
          code
        }
      }
    }
  `;

  const variables = { cartId };

  const response = await axios.post(
    storefrontEndpoint,
    { query, variables },
    {
      headers: {
        'X-Shopify-Storefront-Access-Token': SHOPIFY_API_TOKEN,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data.data.cart;
};

// Apply Discount API
app.post('/apply-discount', async (req, res) => {
  const { discount_code, cart } = req.body;

  console.log("Received Discount Code:", discount_code);
  console.log("Received Cart:", JSON.stringify(cart, null, 2));

  if (!discount_code || !cart || !cart.token) {
    return res.status(400).json({ error: 'Discount code and cart token are required' });
  }

  const cartId = `gid://shopify/Cart/${cart.token}`;
  const storefrontEndpoint = `https://${SHOPIFY_STORE}/api/${STOREFRONT_API_VERSION}/graphql.json`;

  try {
    // Step 1: Fetch current cart data to get existing discount codes
    const currentCart = await fetchCartData(cartId);
    const existingDiscountCodes = currentCart.discountCodes
      .filter((dc) => dc.applicable)
      .map((dc) => dc.code);

    // Step 2: Attempt to apply the new discount code
    const mutation = `
      mutation cartDiscountCodesUpdate($cartId: ID!, $discountCodes: [String!]) {
        cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $discountCodes) {
          cart {
            id
            discountCodes {
              applicable
              code
            }
            totalQuantity
            cost {
              subtotalAmount {
                amount
                currencyCode
              }
              totalAmount {
                amount
                currencyCode
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      cartId,
      discountCodes: [...existingDiscountCodes, discount_code], // Include existing codes + new code
    };

    const response = await axios.post(
      storefrontEndpoint,
      { query: mutation, variables },
      {
        headers: {
          'X-Shopify-Storefront-Access-Token': SHOPIFY_API_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );

    const result = response.data.data.cartDiscountCodesUpdate;

    if (result.userErrors.length > 0) {
      return res.status(400).json({
        error: 'Failed to apply discount',
        details: result.userErrors,
      });
    }

    const cartData = result.cart;
    const appliedDiscount = cartData.discountCodes.find((dc) => dc.code === discount_code);

    if (!appliedDiscount || !appliedDiscount.applicable) {
      // If the new code isn't applicable, revert to existing codes
      if (existingDiscountCodes.length > 0) {
        const revertVariables = {
          cartId,
          discountCodes: existingDiscountCodes,
        };

        await axios.post(
          storefrontEndpoint,
          { query: mutation, variables: revertVariables },
          {
            headers: {
              'X-Shopify-Storefront-Access-Token': SHOPIFY_API_TOKEN,
              'Content-Type': 'application/json',
            },
          }
        );
      }

      return res.status(400).json({
        error: 'Discount code is not applicable',
        details: 'The provided discount code cannot be applied to this cart',
      });
    }

    res.json({
      success: true,
      discount_code: discount_code,
      applicable: true,
      cart: {
        id: cartData.id,
        total_quantity: cartData.totalQuantity,
        subtotal: cartData.cost.subtotalAmount.amount,
        total: cartData.cost.totalAmount.amount,
        currency: cartData.cost.totalAmount.currencyCode,
      },
    });
  } catch (error) {
    console.error("Error applying discount:", error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to apply discount',
      details: error.response?.data?.errors || error.message,
    });
  }
});

// Start Server
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));