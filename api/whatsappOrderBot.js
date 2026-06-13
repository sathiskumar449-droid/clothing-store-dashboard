import axios from "axios";

// 🔥 Google Sheet API
const SHEET_URL = "https://opensheet.elk.sh/1yQ-mR9fdCHXDB5405KbCWzMfq_SUSSUAbwe7AUpMZtw/Sheet1";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_ID || process.env.PHONE_NUMBER_ID;

// 🔹 Fetch products from Google Sheet
async function getProducts() {
  const res = await axios.get(SHEET_URL);
  return res.data;
}

// 🔹 Send text message
async function sendText(to, text) {
  if (!WHATSAPP_TOKEN) {
    throw new Error("Missing WhatsApp config: set WHATSAPP_TOKEN in .env");
  }

  if (!PHONE_NUMBER_ID) {
    throw new Error("Missing WhatsApp config: set PHONE_ID or PHONE_NUMBER_ID in .env");
  }

  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// 🔹 Send image
async function sendImage(to, imageUrl, caption = "") {
  if (!WHATSAPP_TOKEN) {
    throw new Error("Missing WhatsApp config: set WHATSAPP_TOKEN in .env");
  }

  if (!PHONE_NUMBER_ID) {
    throw new Error("Missing WhatsApp config: set PHONE_ID or PHONE_NUMBER_ID in .env");
  }

  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: to,
      type: "image",
      image: {
        link: imageUrl,
        caption: caption
      }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// 🔹 Memory (simple user state)
const userState = {};

// 🔹 MAIN WEBHOOK
export const handleIncomingMessage = async (req, res) => {
  try {
    // ✅ verification
    if (req.method === "GET") {
      return res.send(req.query["hub.challenge"]);
    }

    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const text = msg.text?.body?.trim();

    console.log("User:", text);

    const products = await getProducts();

    // ===============================
    // 🔥 STEP 1: USER SENDS SHIRT CODE
    // ===============================
    if (text.startsWith("S-")) {
      const shirt = products.find(p => p.Code === text);

      if (!shirt) {
        await sendText(from, "❌ Product not found");
        return res.sendStatus(200);
      }

      userState[from] = { shirt };

      // 👕 Send shirt image
      await sendImage(from, shirt.Image, `👕 ${shirt.Name}\n₹${shirt.Price}`);

      // 📏 Ask size
      await sendText(from, "Select size: S / M / L / XL");

      return res.sendStatus(200);
    }

    // ===============================
    // 🔥 STEP 2: SIZE SELECT
    // ===============================
    if (["S", "M", "L", "XL"].includes(text)) {
      const state = userState[from];
      if (!state) return res.sendStatus(200);

      state.size = text;

      await sendText(from, "🔥 Showing matching pants...");

      // 👖 find matching pants
      const pants = products.filter(p => p.Type === "pant");

      state.options = pants.slice(0, 2);

      // send options with image
      for (let i = 0; i < state.options.length; i++) {
        const pant = state.options[i];

        await sendImage(
          from,
          pant.Image,
          `Option ${i + 1}\n${pant.Name}\n₹${pant.Price}\n\nReply with ${i + 1}`
        );
      }

      return res.sendStatus(200);
    }

    // ===============================
    // 🔥 STEP 3: OPTION SELECT (1 or 2)
    // ===============================
    if (text === "1" || text === "2") {
      const state = userState[from];
      if (!state) return res.sendStatus(200);

      const selectedPant = state.options[Number(text) - 1];
      state.pant = selectedPant;

      await sendText(
        from,
        `✅ You selected: ${selectedPant.Name}\n\nConfirm order? (YES / NO)`
      );

      return res.sendStatus(200);
    }

    // ===============================
    // 🔥 STEP 4: CONFIRM ORDER
    // ===============================
    if (text.toLowerCase() === "yes") {
      const state = userState[from];
      if (!state) return res.sendStatus(200);

      await sendText(
        from,
        `🎉 Order Confirmed!\n\n👕 ${state.shirt.Name}\n👖 ${state.pant.Name}\n📏 Size: ${state.size}\n\nThank you for shopping!`
      );

      delete userState[from];

      return res.sendStatus(200);
    }

    return res.sendStatus(200);

  } catch (err) {
    console.error(err);
    return res.sendStatus(500);
  }
};
