/**
 * Shell UI locale dictionary. English is default.
 * Loaded before payload when listed in content_scripts, or inlined via payload.
 */
(function (global) {
  var LOCALES = {
    en: {
      welcome: "Welcome",
      welcomeTitle: "Welcome to degitalservice",
      activatedLoading: "✓ License activated. Loading extension...",
      noResponse: "No response from the extension service.",
      activateSub: "Activate your license to unlock all premium tools of the extension.",
      licenseKey: "License Key",
      remember: "Save license on this device",
      activate: "Activate License",
      verifying: "Verifying...",
      enterKey: "Enter your license key.",
      language: "Language",
      close: "Close",
      method3: "Method 3",
      method3Desc: "Advanced Sending",
      method4: "Method 4",
      method4Desc: "Express Sending",
    },
    es: {
      welcome: "Bienvenido",
      welcomeTitle: "Bienvenido a degitalservice",
      activatedLoading: "✓ Licencia activada. Cargando la extensión...",
      noResponse: "Sin respuesta del servicio de la extensión.",
      activateSub: "Activa tu licencia para desbloquear todas las herramientas premium.",
      licenseKey: "Clave de licencia",
      remember: "Guardar licencia en este dispositivo",
      activate: "Activar licencia",
      verifying: "Verificando...",
      enterKey: "Introduce tu clave de licencia.",
      language: "Idioma",
      close: "Cerrar",
      method3: "Método 3",
      method3Desc: "Envío avanzado",
      method4: "Método 4",
      method4Desc: "Envío express",
    },
    pt: {
      welcome: "Bem-vindo",
      welcomeTitle: "Bem-vindo ao degitalservice",
      activatedLoading: "✓ Licença ativada. Carregando a extensão...",
      noResponse: "Sem resposta do serviço da extensão.",
      activateSub: "Ative sua licença para desbloquear todas as ferramentas premium.",
      licenseKey: "Chave de licença",
      remember: "Salvar licença neste dispositivo",
      activate: "Ativar licença",
      verifying: "Verificando...",
      enterKey: "Digite sua chave de licença.",
      language: "Idioma",
      close: "Fechar",
      method3: "Método 3",
      method3Desc: "Envio avançado",
      method4: "Método 4",
      method4Desc: "Envio express",
    },
    de: {
      welcome: "Willkommen",
      welcomeTitle: "Willkommen bei degitalservice",
      activatedLoading: "✓ Lizenz aktiviert. Erweiterung wird geladen...",
      noResponse: "Keine Antwort vom Erweiterungsdienst.",
      activateSub: "Aktiviere deine Lizenz, um alle Premium-Tools freizuschalten.",
      licenseKey: "Lizenzschlüssel",
      remember: "Lizenz auf diesem Gerät speichern",
      activate: "Lizenz aktivieren",
      verifying: "Wird geprüft...",
      enterKey: "Gib deinen Lizenzschlüssel ein.",
      language: "Sprache",
      close: "Schließen",
      method3: "Methode 3",
      method3Desc: "Erweitertes Senden",
      method4: "Methode 4",
      method4Desc: "Express-Senden",
    },
  };

  var ACTIVATION_ERRORS = {
    en: {
      invalid_license: "Invalid license key.",
      license_expired: "This license has expired.",
      license_disabled: "This license has been disabled.",
      license_revoked: "This license has been revoked.",
      license_deleted: "This license no longer exists.",
      device_limit: "This license has reached its device limit. Ask your admin to reset devices.",
      device_mismatch: "This license is registered to a different device.",
      build_revoked: "This extension build is no longer supported. Please download the latest version.",
      unknown_build: "This extension build is not recognised. Please download the latest version.",
      no_build_config: "This extension build is misconfigured. Please download the latest version.",
      network: "Could not reach the licensing server (no connection). Check your network and try again.",
      server_unreachable: "The licensing server is not responding correctly. This is on our side — please try again shortly.",
      server_error: "The licensing server hit an internal error. Please try again shortly.",
    },
    es: {
      invalid_license: "Clave de licencia no válida.",
      license_expired: "Esta licencia ha caducado.",
      license_disabled: "Esta licencia está deshabilitada.",
      license_revoked: "Esta licencia ha sido revocada.",
      license_deleted: "Esta licencia ya no existe.",
      device_limit: "Esta licencia alcanzó el límite de dispositivos. Pide al admin restablecer dispositivos.",
      device_mismatch: "Esta licencia está registrada en otro dispositivo.",
      build_revoked: "Esta versión de la extensión ya no es compatible. Descarga la última.",
      unknown_build: "Esta versión de la extensión no es reconocida. Descarga la última.",
      no_build_config: "Esta versión está mal configurada. Descarga la última.",
      network: "No se pudo contactar al servidor de licencias. Revisa tu red e inténtalo de nuevo.",
      server_unreachable: "El servidor de licencias no responde correctamente. Inténtalo en breve.",
      server_error: "Error interno del servidor de licencias. Inténtalo en breve.",
    },
    pt: {
      invalid_license: "Chave de licença inválida.",
      license_expired: "Esta licença expirou.",
      license_disabled: "Esta licença foi desativada.",
      license_revoked: "Esta licença foi revogada.",
      license_deleted: "Esta licença não existe mais.",
      device_limit: "Esta licença atingiu o limite de dispositivos. Peça ao admin para redefinir.",
      device_mismatch: "Esta licença está registrada em outro dispositivo.",
      build_revoked: "Esta versão da extensão não é mais suportada. Baixe a mais recente.",
      unknown_build: "Esta versão da extensão não é reconhecida. Baixe a mais recente.",
      no_build_config: "Esta versão está mal configurada. Baixe a mais recente.",
      network: "Não foi possível alcançar o servidor de licenças. Verifique a rede e tente novamente.",
      server_unreachable: "O servidor de licenças não está respondendo corretamente. Tente em breve.",
      server_error: "Erro interno no servidor de licenças. Tente em breve.",
    },
    de: {
      invalid_license: "Ungültiger Lizenzschlüssel.",
      license_expired: "Diese Lizenz ist abgelaufen.",
      license_disabled: "Diese Lizenz wurde deaktiviert.",
      license_revoked: "Diese Lizenz wurde widerrufen.",
      license_deleted: "Diese Lizenz existiert nicht mehr.",
      device_limit: "Geräte-Limit erreicht. Bitte Admin um Reset der Geräte bitten.",
      device_mismatch: "Diese Lizenz ist auf einem anderen Gerät registriert.",
      build_revoked: "Dieser Build wird nicht mehr unterstützt. Bitte neueste Version laden.",
      unknown_build: "Dieser Build wird nicht erkannt. Bitte neueste Version laden.",
      no_build_config: "Dieser Build ist falsch konfiguriert. Bitte neueste Version laden.",
      network: "Lizenzserver nicht erreichbar. Netz prüfen und erneut versuchen.",
      server_unreachable: "Lizenzserver antwortet nicht korrekt. Bitte bald erneut versuchen.",
      server_error: "Interner Fehler beim Lizenzserver. Bitte bald erneut versuchen.",
    },
  };

  function normalize(locale) {
    var v = String(locale || "en").toLowerCase().slice(0, 2);
    return LOCALES[v] ? v : "en";
  }

  function t(locale, key) {
    var loc = normalize(locale);
    return (LOCALES[loc] && LOCALES[loc][key]) || LOCALES.en[key] || key;
  }

  function activationError(locale, reason) {
    var loc = normalize(locale);
    var pack = ACTIVATION_ERRORS[loc] || ACTIVATION_ERRORS.en;
    return pack[reason] || ACTIVATION_ERRORS.en[reason] || reason || ACTIVATION_ERRORS.en.server_error;
  }

  global.__PK_I18N = {
    LOCALES: LOCALES,
    normalize: normalize,
    t: t,
    activationError: activationError,
    supported: ["en", "es", "pt", "de"],
  };
})(typeof window !== "undefined" ? window : globalThis);

