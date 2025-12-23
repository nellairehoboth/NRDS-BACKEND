// Helper: generate an order number (fallback in case model defaults are bypassed)
const generateOrderNumber = () =>
  'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5).toUpperCase();

// Helper: send SMS via Twilio if configured (best-effort, non-blocking)
function normalizePhoneE164(num) {
  if (!num) return '';
  let n = String(num).replace(/[^0-9+]/g, '');
  // If already starts with '+', assume E.164 
  if (n.startsWith('+')) return n;
  // Assume India (+91) if no country code
  if (n.length === 10) return `+91${n}`;
  // Fallback: prefix +
  return `+${n}`;
}

// Helper: send order cancellation email (best-effort, non-blocking)
async function sendOrderCancelEmailNotification(order, userId) {
  try {
    if (!EMAIL_ENABLED) return;
    const { BREVO_API_KEY, EMAIL_FROM } = process.env;
    if (!BREVO_API_KEY || !EMAIL_FROM) {
      if (EMAIL_ENABLED) console.warn('Brevo API key or EMAIL_FROM missing');
      return;
    }

    // Determine recipient
    let toEmail = process.env.EMAIL_FORCE_TO || undefined;
    if (!toEmail && userId) {
      const u = await User.findById(userId).select('email');
      toEmail = u?.email;
    }
    if (!toEmail && process.env.EMAIL_TEST_TO) {
      toEmail = process.env.EMAIL_TEST_TO;
    }
    if (!toEmail) return;

    let SibApiV3Sdk;
    try { SibApiV3Sdk = require('@getbrevo/brevo'); } catch (_) { return; }

    const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
    apiInstance.setApiKey(SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY);

    const subject = `Order Cancelled: ${order.orderNumber}`;
    const text = `Hello,\n\nYour order ${order.orderNumber} has been cancelled. If this was a mistake, please place a new order.\n\nGroceryVoice`;
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#222">
        <h2>Order Cancelled</h2>
        <p>Your order has been cancelled as requested.</p>
        <p><strong>Order No:</strong> ${order.orderNumber}</p>
        <p>If this was a mistake, you can place a new order anytime.</p>
        <p style="color:#666">GroceryVoice</p>
      </div>
    `;

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = html;
    sendSmtpEmail.textContent = text;

    // Parse EMAIL_FROM (e.g. "NRDS <email@example.com>")
    let senderName = "GroceryVoice";
    let senderEmail = EMAIL_FROM;
    if (EMAIL_FROM.includes('<')) {
      const match = EMAIL_FROM.match(/"?([^"<]+)"?\s*<([^>]+)>/);
      if (match) {
        senderName = match[1].trim();
        senderEmail = match[2].trim();
      }
    }

    sendSmtpEmail.sender = { name: senderName, email: senderEmail };
    sendSmtpEmail.to = [{ email: toEmail }];

    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    if (EMAIL_ENABLED) console.log('Email cancel notify success:', data.messageId, 'to', toEmail);
  } catch (err) {
    if (EMAIL_ENABLED) console.error('Email cancel notify error (non-fatal):', err.response?.body || err.message || err);
  }
}

// Feature flags (default off): set ENABLE_EMAIL_NOTIFICATIONS to 'true' in .env to enable
const EMAIL_ENABLED = String(process.env.ENABLE_EMAIL_NOTIFICATIONS || '').toLowerCase() === 'true';

// Helper: send order confirmation email using Nodemailer (best-effort, non-blocking)
async function sendOrderEmailNotification(order, userId) {
  try {
    if (!EMAIL_ENABLED) return;
    const { BREVO_API_KEY, EMAIL_FROM } = process.env;
    if (!BREVO_API_KEY || !EMAIL_FROM) return;

    // Determine recipient
    let toEmail = process.env.EMAIL_FORCE_TO || undefined;
    if (!toEmail && userId) {
      const u = await User.findById(userId).select('email');
      toEmail = u?.email;
    }
    if (!toEmail && process.env.EMAIL_TEST_TO) {
      toEmail = process.env.EMAIL_TEST_TO;
    }
    if (!toEmail) return;

    let SibApiV3Sdk;
    try { SibApiV3Sdk = require('@getbrevo/brevo'); } catch (_) { return; }

    const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
    apiInstance.setApiKey(SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey, BREVO_API_KEY);

    // Parse EMAIL_FROM
    let senderName = "GroceryVoice";
    let senderEmail = EMAIL_FROM;
    if (EMAIL_FROM.includes('<')) {
      const match = EMAIL_FROM.match(/"?([^"<]+)"?\s*<([^>]+)>/);
      if (match) {
        senderName = match[1].trim();
        senderEmail = match[2].trim();
      }
    }

    const subject = `Order Confirmed: ${order.orderNumber}`;
    const text = `Hello,\n\nYour order ${order.orderNumber} has been placed successfully.\nTotal: ₹${order.totalAmount}.\n\nThank you for shopping with GroceryVoice!`;
    const itemsHtml = (order.items || []).map(i => `<li>${i.name} x ${i.quantity} — ₹${i.subtotal?.toFixed?.(2) ?? (i.price * i.quantity)}</li>`).join('');
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#222">
        <h2>Order Confirmed</h2>
        <p>Thank you for your purchase! Your order has been placed successfully.</p>
        <p><strong>Order No:</strong> ${order.orderNumber}</p>
        <ul>${itemsHtml}</ul>
        <p><strong>Total:</strong> ₹${order.totalAmount}</p>
        <p>We will notify you when your order ships.</p>
        <p style="color:#666">GroceryVoice</p>
      </div>
    `;

    // Customer Email
    const customerSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    customerSmtpEmail.subject = subject;
    customerSmtpEmail.htmlContent = html;
    customerSmtpEmail.textContent = text;
    customerSmtpEmail.sender = { name: senderName, email: senderEmail };
    customerSmtpEmail.to = [{ email: toEmail }];

    const customerData = await apiInstance.sendTransacEmail(customerSmtpEmail).catch(e => {
      if (EMAIL_ENABLED) console.error('Customer email failed:', e.response?.body || e.message);
      return null;
    });
    if (EMAIL_ENABLED && customerData) console.log('Email notify success:', customerData.messageId, 'to', toEmail);

    // Admin Notification
    try {
      const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
      if (adminEmail) {
        let replyToAddress = toEmail;
        let userName = 'Customer';
        if (userId) {
          try {
            const userDetails = await User.findById(userId).select('name email');
            if (userDetails) {
              if (userDetails.email) replyToAddress = userDetails.email;
              if (userDetails.name) userName = userDetails.name;
            }
          } catch (uErr) { console.error('Admin notify user lookup failed', uErr); }
        }

        const adminSubject = `${userName} - New Order ${order.orderNumber}`;
        const adminHtml = `
          <div style="font-family:Arial,sans-serif;line-height:1.5;color:#222">
            <h2>New Order Received</h2>
            <p><strong>Customer:</strong> ${userName} (<a href="mailto:${replyToAddress}">${replyToAddress}</a>)</p>
            <p><strong>Order No:</strong> ${order.orderNumber}</p>
            <p><strong>Total:</strong> ₹${order.totalAmount}</p>
            <hr style="border:0;border-top:1px solid #eee;margin:20px 0;" />
            <h3>Items:</h3>
            <ul>${itemsHtml}</ul>
            <p>Hitting <strong>Reply</strong> will reply directly to the customer.</p>
          </div>
        `;

        const adminSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        adminSmtpEmail.subject = adminSubject;
        adminSmtpEmail.htmlContent = adminHtml;
        adminSmtpEmail.sender = { name: senderName, email: senderEmail }; // Use verified sender
        adminSmtpEmail.replyTo = { email: replyToAddress };
        adminSmtpEmail.to = [{ email: adminEmail }];

        const adminData = await apiInstance.sendTransacEmail(adminSmtpEmail).catch(e => {
          if (EMAIL_ENABLED) console.error('Admin notify failed:', e.response?.body || e.message);
          return null;
        });
        if (EMAIL_ENABLED && adminData) console.log('Admin notify success:', adminData.messageId, 'to', adminEmail);
      }
    } catch (adminErr) {
      console.error('Admin notify wrapper failed:', adminErr);
    }
  } catch (err) {
    if (EMAIL_ENABLED) console.error('Email notify error (non-fatal):', err.response?.body || err.message || err);
  }
}

// SMS notifications removed by request; email notifications remain.

const crypto = require('crypto');
let Razorpay;
try {
  Razorpay = require('razorpay');
} catch (_) {
  Razorpay = null;
}

const express = require('express');
const Order = require('../models/Order');
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const User = require('../models/User');
const { authenticateToken } = require('./auth');
const router = express.Router();

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

    if (!['PAYMENT_PENDING', 'CREATED', 'pending'].includes(order.status)) {
      return res.status(400).json({ success: false, message: 'Razorpay order can only be created for unpaid orders' });
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

    // Best-effort email notification (does not block response)
    sendOrderEmailNotification(order, req.user.userId).catch(() => { });

    await order.populate('items.product', 'name image unit tax');

    res.json({ success: true, order, message: 'Payment verified and order marked as PAID' });
  } catch (error) {
    console.error('Verify Razorpay payment error:', error);
    res.status(500).json({ success: false, message: 'Failed to verify payment' });
  }
});

// Get single order
router.get('/:id', async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      user: req.user.userId
    }).populate('items.product', 'name image unit tax');

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    res.json({ success: true, order });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch order' });
  }
});

// Create new order
router.post('/', async (req, res) => {
  try {
    const { items, totalAmount, paymentMethod, shippingAddress } = req.body;

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

    // Create order (ensure orderNumber is set explicitly)
    const initialStatus = paymentMethod === 'razorpay' ? 'PAYMENT_PENDING' : 'CREATED';

    const order = new Order({
      user: req.user.userId,
      items: orderItems,
      totalAmount: calculatedTotal,
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
      sendOrderEmailNotification(order, req.user.userId).catch(() => { });
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

    // Restore product stock
    for (const item of order.items) {
      await Product.findByIdAndUpdate(
        item.product,
        { $inc: { stock: item.quantity } }
      );
    }

    order.status = 'CANCELLED';
    await order.save();

    // Best-effort cancellation email (does not block response)
    sendOrderCancelEmailNotification(order, req.user.userId).catch(() => { });

    res.json({ success: true, order, message: 'Order cancelled successfully' });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({ success: false, message: 'Failed to cancel order' });
  }
});



module.exports = router;
