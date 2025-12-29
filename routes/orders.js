const express = require('express');
const crypto = require('crypto');
let Razorpay;
try { Razorpay = require('razorpay'); } catch (e) { console.warn('Razorpay module not found'); }

const Order = require('../models/Order');
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const User = require('../models/User');
const Setting = require('../models/Setting');
const { authenticateToken } = require('./auth');
const sendEmail = require('../utils/email');

const router = express.Router();

// Helper: generate an order number
const generateOrderNumber = () =>
  'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5).toUpperCase();

const calculateDynamicSlabCharge = (dist, slabs = []) => {
  if (!slabs || !slabs.length) return 0;
  const sortedSlabs = [...slabs].sort((a, b) => a.minDistance - b.minDistance);

  // Find the last slab where the distance is at least the minDistance
  const eligibleSlabs = sortedSlabs.filter(s => dist >= s.minDistance);
  if (eligibleSlabs.length > 0) {
    return eligibleSlabs[eligibleSlabs.length - 1].charge;
  }

  return 0;
};

// Helper: Send order confirmation emails
const sendOrderConfirmation = async (order, userId) => {
  try {
    // 1. Send to Customer
    const user = await User.findById(userId);
    if (!user || !user.email) return;

    const itemsHtml = order.items.map(item =>
      `<li>${item.name} x ${item.quantity} - ₹${item.subtotal || (item.price * item.quantity)}</li>`
    ).join('');

    await sendEmail({
      to: user.email,
      subject: `Order Confirmation #${order.orderNumber}`,
      htmlContent: `
        <h3>Thank you for your order!</h3>
        <p>Order ID: <strong>${order.orderNumber}</strong></p>
        <p>Total Amount: ₹${order.totalAmount}</p>
        <h4>Items:</h4>
        <ul>${itemsHtml}</ul>
        <p>We will notify you once your order is shipped.</p>
      `
    });

    // 2. Send to Admin
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@groceryvoice.com'; // Fallback
    await sendEmail({
      to: adminEmail,
      subject: `New Order Received #${order.orderNumber}`,
      htmlContent: `
        <h3>New Order Received</h3>
        <p>Customer: ${user.name} (${user.email})</p>
        <p>Order ID: <strong>${order.orderNumber}</strong></p>
        <p>Total Amount: ₹${order.totalAmount}</p>
        <h4>Items:</h4>
        <ul>${itemsHtml}</ul>
      `
    });

  } catch (error) {
    console.error('Email notification failed:', error);
  }
};


const getVariantInfo = (product, variantId) => {
  const rawId = variantId !== undefined && variantId !== null ? String(variantId).trim() : '';
  if (!rawId) return { variant: null, unitPrice: Number(product.price), label: '' };
  const variant = product?.variants?.id?.(rawId) || null;
  if (!variant || variant.isActive === false) return { variant: null, unitPrice: Number(product.price), label: '' };
  return {
    variant,
    unitPrice: Number(variant.price),
    label: String(variant.label || ''),
  };
};

const getRazorpayClient = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!Razorpay || !keyId || !keySecret) return null;
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};


// All order routes require authentication
router.use(authenticateToken);

// Get user's orders
router.get('/', async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user.userId, hiddenForUser: { $ne: true } })
      .populate('items.product', 'name image unit tax')
      .sort({ createdAt: -1 });

    res.json({ success: true, orders });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch orders' });
  }
});

// Clear all orders from current user's history (soft-delete)
router.post('/clear', async (req, res) => {
  try {
    const result = await Order.updateMany(
      { user: req.user.userId, hiddenForUser: { $ne: true } },
      { $set: { hiddenForUser: true } }
    );
    res.json({ success: true, modifiedCount: result.modifiedCount || 0 });
  } catch (error) {
    console.error('Clear order history error:', error);
    res.status(500).json({ success: false, message: 'Failed to clear order history' });
  }
});

// Hide a single order from current user's history (soft-delete)
router.delete('/:id', async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, user: req.user.userId });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.hiddenForUser) {
      return res.json({ success: true, order, message: 'Order already hidden' });
    }
    order.hiddenForUser = true;
    await order.save();
    res.json({ success: true, order, message: 'Order removed from history' });
  } catch (error) {
    console.error('Hide order error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove order from history' });
  }
});

// Create Razorpay order for an existing DB order
router.post('/razorpay/order', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId is required' });
    }

    const order = await Order.findOne({ _id: orderId, user: req.user.userId });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.paymentMethod !== 'razorpay') {
      return res.status(400).json({ success: false, message: 'Order is not a Razorpay order' });
    }

    if (!['PAYMENT_PENDING', 'CREATED', 'pending', 'CANCELLED', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'Razorpay order can only be created for unpaid or cancelled orders' });
    }

    // If order was cancelled, we need to re-deduct stock
    if (['CANCELLED', 'cancelled'].includes(order.status)) {
      const Product = require('../models/Product');
      for (const item of order.items) {
        const product = await Product.findById(item.product);
        if (!product) continue;

        if (item.variantId) {
          const variant = product.variants.id(item.variantId);
          if (variant && variant.stock !== null) {
            if (variant.stock < item.quantity) {
              return res.status(400).json({ success: false, message: `Insufficient stock for ${product.name} (${item.variantLabel})` });
            }
            variant.stock -= item.quantity;
          }
        } else if (product.stock !== null) {
          if (product.stock < item.quantity) {
            return res.status(400).json({ success: false, message: `Insufficient stock for ${product.name}` });
          }
          product.stock -= item.quantity;
        }
        await product.save();
      }
    }

    const rp = getRazorpayClient();
    if (!rp) {
      return res.status(500).json({ success: false, message: 'Razorpay is not configured on server' });
    }

    // Razorpay amount is in paise
    const amount = Math.round(Number(order.totalAmount) * 100);
    const currency = 'INR';
    const receipt = order.orderNumber;

    const rpOrder = await rp.orders.create({ amount, currency, receipt });

    order.paymentGatewayOrderId = rpOrder.id;
    order.status = 'PAYMENT_PENDING';
    order.paymentStatus = 'pending';
    await order.save();

    res.json({
      success: true,
      keyId: process.env.RAZORPAY_KEY_ID,
      razorpayOrderId: rpOrder.id,
      amount: rpOrder.amount,
      currency: rpOrder.currency,
      orderId: order._id,
    });
  } catch (error) {
    console.error('Create Razorpay order error:', error);
    res.status(500).json({ success: false, message: 'Failed to create Razorpay order' });
  }
});

// Verify Razorpay payment signature and mark order as PAID
router.post('/razorpay/verify', async (req, res) => {
  try {
    const { orderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!orderId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Missing payment verification fields' });
    }

    const order = await Order.findOne({ _id: orderId, user: req.user.userId });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.paymentMethod !== 'razorpay') {
      return res.status(400).json({ success: false, message: 'Order is not a Razorpay order' });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      return res.status(500).json({ success: false, message: 'Razorpay is not configured on server' });
    }

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');

    if (expected !== razorpay_signature) {
      order.paymentStatus = 'failed';
      await order.save();
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    order.paymentStatus = 'paid';
    order.status = 'PAID';
    order.paymentId = razorpay_payment_id;
    order.paymentGatewayOrderId = razorpay_order_id;
    order.paymentSignature = razorpay_signature;
    await order.save();

    // Clear user's cart only after successful payment
    await Cart.findOneAndUpdate(
      { user: req.user.userId },
      { items: [], totalAmount: 0 }
    );

    // Best-effort email notification
    sendOrderConfirmation(order, req.user.userId);

    await order.populate('items.product', 'name image unit tax');

    res.json({ success: true, order, message: 'Payment verified and order marked as PAID' });
  } catch (error) {
    console.error('Verify Razorpay payment error:', error);
    res.status(500).json({ success: false, message: 'Failed to verify payment' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      user: req.user.userId
    }).populate('items.product', 'name image unit tax');

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Access control: if payment is pending or order is cancelled, logic might still allow fetching basic info
    // but the frontend should be aware or we can send a flag.
    const isRestricted = ['PAYMENT_PENDING', 'CANCELLED', 'cancelled'].includes(order.status);

    res.json({ success: true, order, isRestricted });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch order' });
  }
});

// Create new order
router.post('/', async (req, res) => {
  try {
    const { items, totalAmount, paymentMethod, shippingAddress, distance } = req.body;

    if (!items || !items.length) {
      return res.status(400).json({
        success: false,
        message: 'Order must contain at least one item'
      });
    }

    if (!paymentMethod || !['cod', 'razorpay'].includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: 'Valid payment method is required'
      });
    }

    if (!shippingAddress || !shippingAddress.name || !shippingAddress.street) {
      return res.status(400).json({
        success: false,
        message: 'Complete shipping address is required'
      });
    }

    // Verify stock availability and calculate total
    let calculatedTotal = 0;
    const orderItems = [];

    for (const item of items) {
      const productId = item?.product?._id || item?.product;
      const variantId = item?.variantId ?? null;
      if (!productId) {
        return res.status(400).json({
          success: false,
          message: 'Invalid cart item. Missing product id.'
        });
      }
      const product = await Product.findById(productId);
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product not found: ${item?.product?.name || String(productId)}`
        });
      }

      const { variant, unitPrice, label } = getVariantInfo(product, variantId);
      const availableStock = (() => {
        if (variant && variant.stock !== null && variant.stock !== undefined) return Number(variant.stock);
        return Number(product.stock);
      })();

      if (availableStock < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name}${label ? ` (${label})` : ''}`
        });
      }

      const subtotal = unitPrice * item.quantity;
      calculatedTotal += subtotal;

      orderItems.push({
        product: product._id,
        variantId: variant ? variant._id : null,
        variantLabel: label,
        name: product.name,
        price: unitPrice,
        quantity: item.quantity,
        subtotal
      });

      if (variant && variant.stock !== null && variant.stock !== undefined) {
        variant.stock = Number(variant.stock) - Number(item.quantity);
      } else {
        product.stock = Number(product.stock) - Number(item.quantity);
      }
      await product.save();
    }

    // Fetch delivery settings
    let deliveryCharge = 0;
    let freeDeliveryThreshold = 0;
    try {
      const settings = await Setting.findOne();
      if (settings) {
        freeDeliveryThreshold = settings.freeDeliveryThreshold || 0;

        // Calculate charge if below threshold
        if (calculatedTotal < freeDeliveryThreshold) {
          const dist = Number(distance) || 0;
          const limit = settings.freeDistanceLimit || 0;

          if (dist <= limit) {
            deliveryCharge = 0;
          } else {
            // Check if slabs exist
            if (settings.deliverySlabs && settings.deliverySlabs.length > 0) {
              deliveryCharge = calculateDynamicSlabCharge(dist, settings.deliverySlabs);
            } else if (req.body.deliveryCharge !== undefined && req.body.deliveryCharge !== null) {
              // Fallback to manual charge if provided (useful if slabs aren't configured yet)
              deliveryCharge = Number(req.body.deliveryCharge) || 0;
            } else {
              const perKm = settings.deliveryChargePerKm || 0;
              deliveryCharge = dist * perKm;
            }
          }
        }
      }
    } catch (err) {
      console.error('Settings fetch error in orders.js:', err);
    }

    const finalTotal = calculatedTotal + deliveryCharge;

    // Create order (ensure orderNumber is set explicitly)
    const initialStatus = paymentMethod === 'razorpay' ? 'PAYMENT_PENDING' : 'CREATED';

    const order = new Order({
      user: req.user.userId,
      items: orderItems,
      totalAmount: finalTotal,
      deliveryCharge,
      freeDeliveryThreshold,
      paymentMethod,
      shippingAddress,
      paymentStatus: 'pending',
      status: initialStatus,
      orderNumber: generateOrderNumber()
    });

    await order.save();

    // For COD: clear cart immediately and send confirmation email.
    // For Razorpay: cart is cleared only after successful payment verification.
    if (paymentMethod === 'cod') {
      sendOrderConfirmation(order, req.user.userId);
      await Cart.findOneAndUpdate(
        { user: req.user.userId },
        { items: [], totalAmount: 0 }
      );
    }

    // Populate the order for response
    await order.populate('items.product', 'name image unit tax');

    res.status(201).json({
      success: true,
      order,
      message: 'Order placed successfully'
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ success: false, message: 'Failed to create order' });
  }
});

// Cancel Razorpay payment / Order initiated but not completed
router.post('/razorpay/cancel', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId is required' });

    const order = await Order.findOne({ _id: orderId, user: req.user.userId });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Only allow cancelling if it's still in a pending state
    if (!['CREATED', 'PAYMENT_PENDING', 'pending'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'Order cannot be cancelled at this stage' });
    }

    // Restore stock
    for (const item of order.items) {
      const productId = item.product;
      const variantId = item.variantId;
      const product = await Product.findById(productId);
      if (product) {
        if (variantId) {
          const variant = product.variants.id(variantId);
          if (variant && variant.stock !== null) {
            variant.stock = Number(variant.stock) + Number(item.quantity);
          }
        } else {
          product.stock = Number(product.stock) + Number(item.quantity);
        }
        await product.save();
      }
    }

    order.status = 'CANCELLED';
    order.paymentStatus = 'failed';
    // order.hiddenForUser = true; // Removed so user can see it in history and retry
    await order.save();

    res.json({ success: true, message: 'Payment cancelled, order hidden and stock restored' });
  } catch (error) {
    console.error('Razorpay cancel error:', error);
    res.status(500).json({ success: false, message: 'Failed to cancel payment process' });
  }
});

// Cancel order (only if not yet confirmed/processed/shipped/delivered)
router.put('/:id/cancel', async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      user: req.user.userId
    });

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (!['CREATED', 'PAYMENT_PENDING', 'pending'].includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: 'Only orders before confirmation can be cancelled'
      });
    }

    // Restore product stock (robust variant-aware logic)
    for (const item of order.items) {
      const productId = item.product;
      const variantId = item.variantId;
      const product = await Product.findById(productId);
      if (product) {
        if (variantId) {
          const variant = product.variants.id(variantId);
          if (variant && variant.stock !== null) {
            variant.stock = Number(variant.stock) + Number(item.quantity);
          }
        } else {
          product.stock = Number(product.stock) + Number(item.quantity);
        }
        await product.save();
      }
    }

    order.status = 'CANCELLED';
    await order.save();

    // Best-effort cancellation email
    sendEmail({
      to: (await User.findById(req.user.userId)).email,
      subject: `Order Cancelled: ${order.orderNumber}`,
      htmlContent: `<p>Your order ${order.orderNumber} has been cancelled.</p>`
    });

    res.json({ success: true, order, message: 'Order cancelled successfully' });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({ success: false, message: 'Failed to cancel order' });
  }
});



module.exports = router;
