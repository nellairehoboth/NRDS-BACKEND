const express = require('express');
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const { authenticateToken } = require('./auth');
const router = express.Router();

// All cart routes require authentication
router.use(authenticateToken);

const getVariantInfo = (product, variantId) => {
  const rawId = variantId !== undefined && variantId !== null ? String(variantId).trim() : '';
  if (!rawId) return { variant: null, unitPrice: product.price, label: '' };
  const variant = product?.variants?.id?.(rawId) || null;
  if (!variant || variant.isActive === false) return { variant: null, unitPrice: product.price, label: '' };
  return {
    variant,
    unitPrice: Number(variant.price),
    label: String(variant.label || ''),
  };
};

const recomputeTotal = (cart) => {
  const items = Array.isArray(cart?.items) ? cart.items : [];
  cart.totalAmount = items.reduce((sum, it) => {
    const price = Number(it?.price || 0);
    const qty = Number(it?.quantity || 0);
    return sum + price * qty;
  }, 0);
};

// Get user's cart
router.get('/', async (req, res) => {
  try {
    let cart = await Cart.findOne({ user: req.user.userId })
      .populate('items.product', 'name price image unit stock variants');

    if (!cart) {
      cart = new Cart({ user: req.user.userId, items: [] });
      await cart.save();
    }

    // Capture raw product IDs before population
    const rawItems = cart.items.map(it => ({
      _id: it._id,
      productId: it.product ? it.product.toString() : null
    }));

    await cart.populate('items.product', 'name price image unit stock variants');

    const cartObj = cart.toObject();
    if (cartObj.items) {
      cartObj.items = cartObj.items.map((it, idx) => {
        // If population failed (product deleted), it.product will be null
        // Fallback to the raw ID we captured before
        const pId = it.product?._id || rawItems[idx]?.productId;
        const finalId = pId ? pId.toString() : null;
        return {
          ...it,
          productId: finalId
        };
      });
    }

    res.json({ success: true, cart: cartObj });
  } catch (error) {
    console.error('Get cart error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch cart' });
  }
});

// Add item to cart
router.post('/add', async (req, res) => {
  try {
    const { productId, quantity = 1, variantId = null } = req.body;

    if (!productId) {
      return res.status(400).json({ success: false, message: 'Product ID is required' });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const { variant, unitPrice, label } = getVariantInfo(product, variantId);

    const availableStock = (() => {
      if (variant && variant.stock !== null && variant.stock !== undefined) return Number(variant.stock);
      return Number(product.stock);
    })();

    if (availableStock < quantity) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient stock available'
      });
    }

    let cart = await Cart.findOne({ user: req.user.userId });
    if (!cart) {
      cart = new Cart({ user: req.user.userId, items: [] });
    }

    // Check if item already exists in cart
    const variantKey = variant ? String(variant._id) : null;
    const existingItemIndex = cart.items.findIndex((item) => {
      const sameProduct = item.product.toString() === productId;
      const itemVar = item.variantId ? item.variantId.toString() : null;
      return sameProduct && itemVar === variantKey;
    });

    if (existingItemIndex > -1) {
      // Update quantity
      const newQuantity = cart.items[existingItemIndex].quantity + quantity;
      if (newQuantity > availableStock) {
        return res.status(400).json({
          success: false,
          message: 'Cannot add more items than available stock'
        });
      }
      cart.items[existingItemIndex].quantity = newQuantity;
    } else {
      // Add new item
      cart.items.push({
        product: productId,
        variantId: variant ? variant._id : null,
        variantLabel: label,
        quantity,
        price: unitPrice
      });
    }

    recomputeTotal(cart);

    await cart.save();
    await cart.populate('items.product', 'name price image unit stock variants');

    res.json({ success: true, cart, message: 'Item added to cart' });
  } catch (error) {
    console.error('Add to cart error:', error);
    res.status(500).json({ success: false, message: 'Failed to add item to cart' });
  }
});

// Update cart item quantity
router.put('/update', async (req, res) => {
  try {
    const { productId, quantity, variantId = null } = req.body;

    if (!productId || quantity < 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid product ID and quantity are required'
      });
    }

    const userId = req.user.userId;
    const variantKey = variantId ? String(variantId).trim() : null;

    // Check stock availability if increasing quantity
    // (We could optimize this to only check if newQty > oldQty, but checking absolute is safer)
    if (quantity > 0) {
      const product = await Product.findById(productId);
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

      const { variant } = getVariantInfo(product, variantKey);
      const availableStock = (() => {
        if (variant && variant.stock !== null && variant.stock !== undefined) return Number(variant.stock);
        return Number(product.stock);
      })();

      if (quantity > availableStock) {
        return res.status(400).json({ success: false, message: 'Insufficient stock available' });
      }
    }

    let cart;
    const query = { user: userId, "items.product": productId };
    // Add variant check to query specifically.
    // Note: To match null variantId in array, we might need explicit query, but usually existing logic matches simple atomic updates well.
    // However, finding the specific element in array with multiple criteria (product AND variant) for $set is tricky used with `items.$`.
    // Easier approach: Use the existing logic but RETRY on version error, OR just fetch-modify-save with retry loop.
    // Given the complexity of specific-variant-update in mixed array:
    // Let's stick to fetch-save but add a simple RETRY mechanism.

    let retries = 3;
    while (retries > 0) {
      try {
        cart = await Cart.findOne({ user: userId });
        if (!cart) return res.status(404).json({ success: false, message: 'Cart not found' });

        const itemIndex = cart.items.findIndex((item) => {
          const sameProduct = item.product.toString() === productId;
          const itemVar = item.variantId ? item.variantId.toString() : null;
          return sameProduct && itemVar === (variantKey || null);
        });

        if (itemIndex === -1) {
          return res.status(404).json({ success: false, message: 'Item not found in cart' });
        }

        if (quantity === 0) {
          cart.items.splice(itemIndex, 1);
        } else {
          cart.items[itemIndex].quantity = quantity;
        }

        recomputeTotal(cart);
        await cart.save();
        await cart.populate('items.product', 'name price image unit stock variants');

        return res.json({ success: true, cart });
      } catch (err) {
        if (err.name === 'VersionError' && retries > 1) {
          retries--;
          continue; // Retry
        }
        throw err; // Re-throw if not version error or out of retries
      }
    }
  } catch (error) {
    console.error('Update cart error:', error);
    res.status(500).json({ success: false, message: 'Failed to update cart' });
  }
});

// Remove item from cart
router.delete('/remove/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const variantId = req.query?.variantId ? String(req.query.variantId).trim() : null;
    const cartItemId = req.query?.cartItemId ? String(req.query.cartItemId).trim() : null;

    let retries = 3;
    while (retries > 0) {
      try {
        const cart = await Cart.findOne({ user: req.user.userId });
        if (!cart) return res.status(404).json({ success: false, message: 'Cart not found' });

        const beforeCount = cart.items.length;

        cart.items = cart.items.filter((item) => {
          // If we have a specific cartItemId, use it (most robust)
          if (cartItemId && item._id.toString() === cartItemId) {
            return false;
          }

          // Fallback to product/variant matching
          const itemProdId = item.product ? item.product.toString() : 'null';
          const sameProduct = itemProdId === productId;

          if (!sameProduct) return true;

          const itemVar = item.variantId ? item.variantId.toString() : null;
          const match = itemVar === (variantId || null);
          return !match;
        });

        recomputeTotal(cart);

        await cart.save();
        await cart.populate('items.product', 'name price image unit stock variants');

        return res.json({ success: true, cart });
      } catch (err) {
        if (err.name === 'VersionError' && retries > 1) {
          retries--;
          continue;
        }
        throw err;
      }
    }
  } catch (error) {
    console.error('Remove from cart error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove item from cart' });
  }
});

// Clear cart
router.delete('/clear', async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user.userId });
    if (!cart) {
      return res.status(404).json({ success: false, message: 'Cart not found' });
    }

    cart.items = [];
    cart.totalAmount = 0;
    await cart.save();

    res.json({ success: true, cart });
  } catch (error) {
    console.error('Clear cart error:', error);
    res.status(500).json({ success: false, message: 'Failed to clear cart' });
  }
});

module.exports = router;
