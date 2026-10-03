/**
 * MongoDB Auth State for Baileys
 * WhatsApp session MongoDB mein save hoti hai — server restart pe bhi safe!
 */
const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

const DB_NAME = 'beu-notifier';
const COLLECTION = 'wa_session';

async function useMongoAuthState(db) {
  const collection = db.collection(COLLECTION);

  const readData = async (key) => {
    try {
      const doc = await collection.findOne({ _id: key });
      if (!doc) return null;
      return JSON.parse(doc.value, BufferJSON.reviver);
    } catch { return null; }
  };

  const writeData = async (key, value) => {
    try {
      await collection.updateOne(
        { _id: key },
        { $set: { value: JSON.stringify(value, BufferJSON.replacer), updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (e) { console.error('Session write error:', e.message); }
  };

  const removeData = async (key) => {
    try { await collection.deleteOne({ _id: key }); } catch {}
  };

  // Load existing creds or create new
  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const val = await readData(`${type}-${id}`);
            if (val) {
              if (type === 'app-state-sync-key') {
                data[id] = proto.Message.AppStateSyncKeyData.fromObject(val);
              } else {
                data[id] = val;
              }
            }
          }
          return data;
        },
        set: async (data) => {
          for (const [category, categoryData] of Object.entries(data)) {
            for (const [id, value] of Object.entries(categoryData || {})) {
              if (value) await writeData(`${category}-${id}`, value);
              else await removeData(`${category}-${id}`);
            }
          }
        }
      }
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    }
  };
}

module.exports = { useMongoAuthState };
