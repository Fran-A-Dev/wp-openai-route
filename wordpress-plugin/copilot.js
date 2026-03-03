(function () {
  const cfg = window.WPAdminCopilotConfig || {};
  const token = typeof cfg.token === "string" ? cfg.token.trim() : "";
  const endpoint = typeof cfg.endpoint === "string" ? cfg.endpoint.trim() : "";
  const STORAGE_KEY = "wp_admin_copilot_state_v1";

  const fabEl = document.getElementById("wp-admin-copilot-fab");
  const panelEl = document.getElementById("wp-admin-copilot-panel");
  const closeEl = document.getElementById("wp-admin-copilot-close");
  const clearEl = document.getElementById("wp-admin-copilot-clear");
  const logEl = document.getElementById("wp-admin-copilot-log");
  const inputEl = document.getElementById("wp-admin-copilot-input");
  const sendEl = document.getElementById("wp-admin-copilot-send");
  const statusEl = document.getElementById("wp-admin-copilot-status");

  if (
    !fabEl ||
    !panelEl ||
    !closeEl ||
    !clearEl ||
    !logEl ||
    !inputEl ||
    !sendEl ||
    !statusEl
  ) {
    return;
  }

  const state = {
    history: [],
    lastSearch: {},
    sending: false,
    panelOpen: false,
  };

  function saveState() {
    try {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          history: state.history,
          lastSearch: state.lastSearch,
          panelOpen: state.panelOpen,
        }),
      );
    } catch (err) {
      console.error("Unable to persist copilot state", err);
    }
  }

  function loadState() {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.history)) {
        state.history = parsed.history.filter(function (msg) {
          return msg && (msg.role === "user" || msg.role === "assistant") && typeof msg.content === "string";
        });
      }
      if (parsed && parsed.lastSearch && typeof parsed.lastSearch === "object") {
        state.lastSearch = parsed.lastSearch;
      }
      state.panelOpen = Boolean(parsed && parsed.panelOpen);
    } catch (err) {
      console.error("Unable to restore copilot state", err);
    }
  }

  function setPanelOpen(open) {
    state.panelOpen = open;
    panelEl.style.display = open ? "block" : "none";
    panelEl.setAttribute("aria-hidden", open ? "false" : "true");
    fabEl.setAttribute("aria-expanded", open ? "true" : "false");
    saveState();
    if (open) {
      inputEl.focus();
    }
  }

  function appendMessage(role, text) {
    const wrapper = document.createElement("div");
    wrapper.style.marginBottom = "10px";

    const label = document.createElement("strong");
    label.textContent = role === "user" ? "You: " : "Assistant: ";

    const body = document.createElement("span");
    body.textContent = text;

    wrapper.appendChild(label);
    wrapper.appendChild(body);
    logEl.appendChild(wrapper);
    logEl.scrollTop = logEl.scrollHeight;

    return body;
  }

  function renderHistory() {
    logEl.innerHTML = "";
    for (let i = 0; i < state.history.length; i += 1) {
      const msg = state.history[i];
      appendMessage(msg.role, msg.content);
    }
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function parseSSE(rawChunk, bufferRef, onEvent) {
    bufferRef.value += rawChunk;

    const parts = bufferRef.value.split("\n\n");
    bufferRef.value = parts.pop() || "";

    for (let i = 0; i < parts.length; i += 1) {
      const frame = parts[i];
      const lines = frame.split("\n");
      let eventName = "message";
      let dataText = "";

      for (let j = 0; j < lines.length; j += 1) {
        const line = lines[j];
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataText += line.slice(5).trim();
        }
      }

      if (!dataText) {
        continue;
      }

      try {
        const payload = JSON.parse(dataText);
        onEvent(eventName, payload);
      } catch (err) {
        console.error("Invalid SSE payload", err);
      }
    }
  }

  async function sendMessage() {
    if (state.sending) {
      return;
    }

    const text = inputEl.value.trim();
    if (!text) {
      return;
    }

    if (!endpoint || !token) {
      setStatus("Set Agent Endpoint URL and Shared Secret Token in WP Copilot settings.");
      setPanelOpen(true);
      return;
    }

    state.sending = true;
    sendEl.disabled = true;
    inputEl.disabled = true;
    setStatus("Sending...");

    appendMessage("user", text);
    state.history.push({ role: "user", content: text });
    inputEl.value = "";
    saveState();

    const assistantBody = appendMessage("assistant", "");
    let assistantFinalText = "";

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-wp-admin-copilot-token": token,
        },
        body: JSON.stringify({
          message: text,
          history: state.history,
          state: { lastSearch: state.lastSearch },
        }),
      });

      if (!response.ok || !response.body) {
        const bodyText = await response.text();
        throw new Error("Request failed: " + bodyText);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const sseBuffer = { value: "" };

      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }

        const chunk = decoder.decode(next.value, { stream: true });
        parseSSE(chunk, sseBuffer, function (eventName, payload) {
          if (eventName === "status") {
            setStatus("Status: " + (payload.stage || "processing"));
            return;
          }

          if (eventName === "delta") {
            assistantFinalText += payload.text || "";
            assistantBody.textContent = assistantFinalText;
            logEl.scrollTop = logEl.scrollHeight;
            return;
          }

          if (eventName === "error") {
            const errText = payload.message || "Unknown server error.";
            setStatus("Error: " + errText);
            if (!assistantFinalText) {
              assistantBody.textContent = errText;
            }
            return;
          }

          if (eventName === "done") {
            if (payload && payload.state && payload.state.lastSearch) {
              state.lastSearch = payload.state.lastSearch;
            }
            setStatus(payload.ok ? "Done" : "Done with errors");
            saveState();
          }
        });
      }

      state.history.push({ role: "assistant", content: assistantFinalText });
      saveState();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unexpected client error.";
      assistantBody.textContent = message;
      setStatus("Error: " + message);
      state.history.push({ role: "assistant", content: message });
      saveState();
    } finally {
      state.sending = false;
      sendEl.disabled = false;
      inputEl.disabled = false;
      inputEl.focus();
    }
  }

  function clearConversation() {
    state.history = [];
    state.lastSearch = {};
    setStatus("Cleared");
    saveState();
    renderHistory();
  }

  fabEl.addEventListener("click", function () {
    setPanelOpen(!state.panelOpen);
  });

  closeEl.addEventListener("click", function () {
    setPanelOpen(false);
  });

  clearEl.addEventListener("click", clearConversation);
  sendEl.addEventListener("click", sendMessage);
  inputEl.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      sendMessage();
    }
  });

  loadState();
  renderHistory();
  setPanelOpen(state.panelOpen);
})();
