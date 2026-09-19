// wd-draftdb.js — 設計図のIndexedDB永続化 (localStorage代替の大容量保存)。
// classic script (wd-state.jsより先に読む)。IDB不可時は各APIがnull/falseを返し、
// 呼び出し側がlocalStorage代替に落とす。DB: "pixdraw" / store: "drafts" ({k, c})。
"use strict";
(function () {
  const DB_NAME = "pixdraw";
  const STORE = "drafts";
  const VER = 1;

  function supported() {
    try {
      return typeof indexedDB !== "undefined" && !!indexedDB
        && typeof indexedDB.open === "function";
    } catch {
      return false;
    }
  }

  let dbPromise = null;
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!supported()) {
        resolve(null);
        return;
      }
      let req = null;
      try {
        req = indexedDB.open(DB_NAME, VER);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: "k" });
          }
        } catch {}
      };
      req.onsuccess = () => {
        try {
          resolve(req.result);
        } catch {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => {
        // 他タブが旧版で開いていても読める版で継続 (成功・失敗はonsuccess/onerrorで確定)
      };
    });
    return dbPromise;
  }

  function storeOf(db, mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  // 全件読込 → Map。失敗時はnull (空とは区別する)。
  async function loadAll() {
    const db = await open();
    if (!db) return null;
    return new Promise((resolve) => {
      const out = new Map();
      let st = null;
      try {
        st = storeOf(db, "readonly");
      } catch {
        resolve(null);
        return;
      }
      let cursor = null;
      try {
        cursor = st.openCursor();
      } catch {
        resolve(null);
        return;
      }
      cursor.onsuccess = () => {
        let cur = null;
        try {
          cur = cursor.result;
        } catch {
          resolve(out);
          return;
        }
        if (!cur) {
          resolve(out);
          return;
        }
        try {
          const v = cur.value;
          if (v && typeof v.k === "string") out.set(v.k, String(v.c || ""));
        } catch {}
        try {
          cur.continue();
        } catch {
          resolve(out);
        }
      };
      cursor.onerror = () => resolve(null);
    });
  }

  // 差分適用 (dirty: key -> color|null。nullは削除)。1トランザクション。
  async function applyDirty(dirty) {
    if (!dirty || dirty.size === 0) return true;
    const db = await open();
    if (!db) return false;
    return new Promise((resolve) => {
      let st = null;
      try {
        st = storeOf(db, "readwrite");
      } catch {
        resolve(false);
        return;
      }
      let done = false;
      const fin = (ok) => {
        if (!done) {
          done = true;
          resolve(ok);
        }
      };
      try {
        st.transaction.oncomplete = () => fin(true);
        st.transaction.onerror = () => fin(false);
        st.transaction.onabort = () => fin(false);
      } catch {}
      try {
        for (const [k, c] of dirty) {
          if (c === null || c === undefined) st.delete(k);
          else st.put({ k, c: String(c) });
        }
      } catch {
        fin(false);
      }
    });
  }

  // 全件置換 (移行時の初回書込用。チャンク分割で巨大txを避ける)。
  async function replaceAll(entries, chunkSize) {
    const db = await open();
    if (!db) return false;
    const n = chunkSize && chunkSize > 0 ? chunkSize : 5000;
    const list = entries || [];
    for (let i = 0; i < list.length || i === 0; i += n) {
      const part = list.slice(i, i + n);
      const first = i === 0;
      const ok = await new Promise((resolve) => {
        let st = null;
        try {
          st = storeOf(db, "readwrite");
        } catch {
          resolve(false);
          return;
        }
        let done = false;
        const fin = (ok2) => {
          if (!done) {
            done = true;
            resolve(ok2);
          }
        };
        try {
          st.transaction.oncomplete = () => fin(true);
          st.transaction.onerror = () => fin(false);
          st.transaction.onabort = () => fin(false);
        } catch {}
        try {
          if (first) st.clear();
          for (const [k, c] of part) st.put({ k, c: String(c) });
        } catch {
          fin(false);
        }
      });
      if (!ok) return false;
      if (part.length < n) break;
    }
    return true;
  }

  try {
    window.wdDraftDb = { open, loadAll, applyDirty, replaceAll, supported };
  } catch {}
})();
