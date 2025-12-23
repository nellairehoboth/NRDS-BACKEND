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

    res.json({ success: true, cart });
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

    const cart = await Cart.findOne({ user: req.user.userId });
    if (!cart) {
      return res.status(404).json({ success: false, message: 'Cart not found' });
    }

    const variantKey = variantId ? String(variantId).trim() : null;
    const itemIndex = cart.items.findIndex((item) => {
      const sameProduct = item.product.toString() === productId;
      const itemVar = item.variantId ? item.variantId.toString() : null;
      return sameProduct && itemVar === (variantKey || null);
    });

    if (itemIndex === -1) {
      return res.status(404).json({ success: false, message: 'Item not found in cart' });
    }

    if (quantity === 0) {
      // Remove item if quantity is 0
      cart.items.splice(itemIndex, 1);
    } else {
      // Check stock availability
      const product = await Product.findById(productId);
      const { variant } = getVariantInfo(product, variantKey);
      const availableStock = (() => {
        if (variant && variant.stock !== null && variant.stock !== undefined) return Number(variant.stock);
        return Number(product.stock);
      })();

      if (quantity > availableStock) {
        return res.status(400).json({ 
          success: false, 
          message: 'Insufficient stock available' 
        });
      }
      cart.items[itemIndex].quantity = quantity;
    }

    recomputeTotal(cart);

    await cart.save();
    await cart.populate('items.product', 'name price image unit stock variants');

    res.json({ success: true, cart });
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

    const cart = await Cart.findOne({ user: req.user.userId });
    if (!cart) {
      return res.status(404).json({ success: false, message: 'Cart not found' });
    }

    cart.items = cart.items.filter((item) => {
      const sameProduct = item.product.toString() === productId;
      if (!sameProduct) return true;
      const itemVar = item.variantId ? item.variantId.toString() : null;
      return itemVar !== (variantId || null);
    });

    recomputeTotal(cart);

    await cart.save();
    await cart.populate('items.product', 'name price image unit stock variants');

    res.json({ success: true, cart });
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
