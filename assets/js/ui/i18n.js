/**
 * Arsin Print Server - UI translations (English + Persian) and the tiny
 * runtime that applies them. Persian switches the document to RTL.
 */
const DICT = {
  en: {
    'app.name': 'Arsin Print Server',
    'app.tagline': 'Wireless printing for any printer',
    'app.hero.title': 'Make any printer wireless - from the browser',
    'app.hero.lead':
      'Pick an application, pick your board, follow the wiring diagram and flash it straight from this page. The firmware turns your printer into a Wi-Fi, Bluetooth or USB-host network printer with a complete web control panel.',
    'nav.home': 'Home',
    'nav.install': 'Install',
    'nav.designer': 'Label designer',
    'nav.troubleshoot': 'Maintenance',
    'nav.docs': 'Docs & API',
    'nav.device': 'My device',
    'action.next': 'Next',
    'action.back': 'Back',
    'action.cancel': 'Cancel',
    'action.save': 'Save',
    'action.copy': 'Copy',
    'action.copied': 'Copied to clipboard',
    'action.download': 'Download',
    'action.print': 'Print',
    'action.send': 'Send to printer',
    'action.test': 'Test connection',
    'action.connect': 'Connect',
    'action.disconnect': 'Disconnect',
    'action.refresh': 'Refresh',
    'action.add': 'Add',
    'action.delete': 'Delete',
    'action.duplicate': 'Duplicate',
    'action.apply': 'Apply',
    'action.reset': 'Reset',
    'action.upload': 'Upload',
    'action.export': 'Export',
    'action.import': 'Import',
    'action.close': 'Close',
    'action.theme': 'Toggle dark mode',
    'action.language': 'Language',
    'step.app': 'Step 1 - choose an application',
    'step.transport': 'Step 2 - choose how the printer connects',
    'step.board': 'Step 3 - choose your board',
    'step.wiring': 'Step 4 - wiring, requirements and guide',
    'step.flash': 'Step 5 - install on the board',
    'step.configure': 'Step 6 - connect and configure',
    'install.title': 'Install Arsin Print Server',
    'install.subtitle': 'Application, transport, board, wiring, flash - one guided flow.',
    'install.compat.filter': 'Only show compatible boards',
    'install.incompatible': 'Incompatible',
    'install.why.incompatible': 'Why is this board greyed out?',
    'install.wiring.diagram': 'Wiring diagram',
    'install.wiring.table': 'Connection table',
    'install.wiring.bom': 'Bill of materials',
    'install.wiring.steps': 'Step by step',
    'install.wiring.requirements': 'Requirements',
    'install.wiring.warnings': 'Warnings',
    'install.wiring.download': 'Download the wiring guide',
    'install.wiring.copy': 'Copy the wiring guide',
    'install.flash.browser': 'Flash from this browser (Web Serial)',
    'install.flash.hint': 'Use Chrome, Edge or another Chromium browser on a desktop, over HTTPS or localhost.',
    'install.flash.manual': 'Manual build',
    'install.flash.sdcard': 'SD card install (Raspberry Pi)',
    'install.flash.notbuilt': 'Firmware for this combination is not built yet. Run the GitHub Actions build or build locally - the exact commands are below.',
    'install.config.title': 'Connect to the device you just flashed',
    'install.config.hint': 'The board starts a Wi-Fi access point called arsin_print_server (password arsin1234). Join it, then press Test connection.',
    'designer.title': 'Label & receipt designer',
    'designer.subtitle': 'Design once, print on ESC/POS, ZPL, TSPL, EPL, CPCL, Star or plain printers.',
    'designer.add.text': 'Text',
    'designer.add.barcode': 'Barcode',
    'designer.add.qrcode': 'QR code',
    'designer.add.image': 'Logo / image',
    'designer.add.line': 'Line',
    'designer.add.box': 'Box',
    'designer.elements': 'Elements',
    'designer.properties': 'Properties',
    'designer.preview': 'Preview',
    'designer.size': 'Label size',
    'designer.language': 'Printer language',
    'designer.mode': 'Output mode',
    'designer.mode.native': 'Native commands (best quality)',
    'designer.mode.raster': 'Raster image (works on any printer)',
    'designer.templates': 'Templates',
    'designer.variables': 'Variables',
    'designer.output': 'Output',
    'designer.output.hint': 'Download the command file, copy it, or send it straight to a connected device.',
    'troubleshoot.title': 'Maintenance & troubleshooting',
    'troubleshoot.subtitle': 'Self test, calibration, head cleaning, counters, raw console and live status.',
    'troubleshoot.group.test': 'Tests',
    'troubleshoot.group.status': 'Status',
    'troubleshoot.group.maintenance': 'Maintenance',
    'troubleshoot.group.config': 'Configuration',
    'troubleshoot.console': 'Raw command console',
    'troubleshoot.console.hint': 'Hex (1B 40) or text with escapes (\\x1b@). Ctrl+Enter sends.',
    'troubleshoot.logs': 'Device log',
    'troubleshoot.export.config': 'Backup configuration',
    'troubleshoot.restore.config': 'Restore configuration',
    'device.status': 'Device status',
    'device.host': 'Device address',
    'device.host.hint': 'arsin_print_server.local, an IP address, or a full URL with port.',
    'device.apikey': 'API key (optional)',
    'device.online': 'Online',
    'device.offline': 'Offline',
    'device.demo': 'Demo mode (no device connected)',
    'wizard.requirements': 'Requirements',
    'common.transport': 'Transport',
    'common.board': 'Board',
    'common.family': 'Family',
    'common.vendor': 'Vendor',
    'common.mcu': 'MCU',
    'common.radios': 'Radios',
    'common.power': 'Power',
    'common.pins': 'Pins',
    'common.notes': 'Notes',
    'common.features': 'Features',
    'common.capabilities': 'Capabilities',
    'common.cables': 'Cables',
    'common.noresults': 'Nothing matches that filter.',
    'common.optional': 'optional',
    'common.required': 'required',
    'common.signal': 'Signal',
    'common.boardSide': 'Board',
    'common.printerSide': 'Printer',
    'common.confidence': 'Confidence',
    'common.confidence.standard': 'Standard',
    'common.confidence.vendor': 'Vendor specific',
    'common.confidence.approximate': 'Approximate - verify',
    'custom.board.add': 'Add a board',
    'custom.board.hint': 'Paste a board JSON object (same shape as data/boards.json entries) or load a file.',
    'custom.board.saved': 'Custom boards are stored in this browser only.',
    'footer.rights': 'Built for makers, repair shops and POS integrators.'
  },
  fa: {
    'app.name': 'سرور چاپ آرسین',
    'app.tagline': 'چاپ بی‌سیم برای هر پرینتری',
    'app.hero.title': 'هر پرینتری را از داخل مرورگر بی‌سیم کنید',
    'app.hero.lead':
      'یک برنامه انتخاب کنید، برد خود را انتخاب کنید، نقشه اتصال را ببینید و همان‌جا از مرورگر روی برد نصب کنید. فرم‌ور پرینتر شما را به پرینتر شبکه‌ای وای‌فای، بلوتوث یا USB میزبان تبدیل می‌کند و یک پنل وب کامل هم روی خودش دارد.',
    'nav.home': 'خانه',
    'nav.install': 'نصب',
    'nav.designer': 'طراحی لیبل',
    'nav.troubleshoot': 'سرویس و رفع عیب',
    'nav.docs': 'مستندات و API',
    'nav.device': 'دستگاه من',
    'action.next': 'بعدی',
    'action.back': 'قبلی',
    'action.cancel': 'انصراف',
    'action.save': 'ذخیره',
    'action.copy': 'کپی',
    'action.copied': 'در حافظه کپی شد',
    'action.download': 'دانلود',
    'action.print': 'چاپ',
    'action.send': 'ارسال به پرینتر',
    'action.test': 'آزمایش اتصال',
    'action.connect': 'اتصال',
    'action.disconnect': 'قطع اتصال',
    'action.refresh': 'بازخوانی',
    'action.add': 'افزودن',
    'action.delete': 'حذف',
    'action.duplicate': 'کپی گرفتن',
    'action.apply': 'اعمال',
    'action.reset': 'بازنشانی',
    'action.upload': 'بارگذاری',
    'action.export': 'خروجی گرفتن',
    'action.import': 'ورود اطلاعات',
    'action.close': 'بستن',
    'action.theme': 'تغییر حالت شب',
    'action.language': 'زبان',
    'step.app': 'گام ۱ - انتخاب برنامه',
    'step.transport': 'گام ۲ - انتخاب روش اتصال پرینتر',
    'step.board': 'گام ۳ - انتخاب برد شما',
    'step.wiring': 'گام ۴ - سیم‌کشی، نیازمندی‌ها و راهنما',
    'step.flash': 'گام ۵ - نصب روی برد',
    'step.configure': 'گام ۶ - اتصال و تنظیمات',
    'install.title': 'نصب سرور چاپ آرسین',
    'install.subtitle': 'برنامه، روش اتصال، برد، سیم‌کشی، نصب - همه در یک مسیر راهنما.',
    'install.compat.filter': 'فقط بردهای سازگار را نشان بده',
    'install.incompatible': 'ناسازگار',
    'install.why.incompatible': 'چرا این برد کم‌رنگ است؟',
    'install.wiring.diagram': 'نقشه اتصال',
    'install.wiring.table': 'جدول اتصالات',
    'install.wiring.bom': 'لیست قطعات',
    'install.wiring.steps': 'مرحله به مرحله',
    'install.wiring.requirements': 'نیازمندی‌ها',
    'install.wiring.warnings': 'هشدارها',
    'install.wiring.download': 'دانلود راهنمای سیم‌کشی',
    'install.wiring.copy': 'کپی راهنمای سیم‌کشی',
    'install.flash.browser': 'نصب از همین مرورگر (Web Serial)',
    'install.flash.hint': 'از کروم یا اِج روی کامپیوتر استفاده کنید (HTTPS یا localhost لازم است).',
    'install.flash.manual': 'ساخت دستی',
    'install.flash.sdcard': 'نصب روی کارت حافظه (رزبری‌پای)',
    'install.flash.notbuilt': 'فرم‌ور این ترکیب هنوز ساخته نشده است. اکشن گیت‌هاب را اجرا کنید یا به‌صورت محلی بسازید - دستورها در پایین آمده است.',
    'install.config.title': 'به دستگاهی که نصب کردید وصل شوید',
    'install.config.hint': 'برد یک شبکه وای‌فای با نام arsin_print_server و رمز arsin1234 می‌سازد. به آن وصل شوید و دکمه آزمایش اتصال را بزنید.',
    'designer.title': 'طراحی لیبل و فیش',
    'designer.subtitle': 'یک‌بار طراحی کنید، روی پرینترهای ESC/POS، ZPL، TSPL، EPL، CPCL، استار یا متنی چاپ کنید.',
    'designer.add.text': 'متن',
    'designer.add.barcode': 'بارکد',
    'designer.add.qrcode': 'کیوآر کد',
    'designer.add.image': 'لوگو / تصویر',
    'designer.add.line': 'خط',
    'designer.add.box': 'کادر',
    'designer.elements': 'اجزا',
    'designer.properties': 'ویژگی‌ها',
    'designer.preview': 'پیش‌نمایش',
    'designer.size': 'اندازه لیبل',
    'designer.language': 'زبان پرینتر',
    'designer.mode': 'حالت خروجی',
    'designer.mode.native': 'دستورهای بومی پرینتر (بهترین کیفیت)',
    'designer.mode.raster': 'تصویر نقطه‌ای (روی هر پرینتری کار می‌کند)',
    'designer.templates': 'قالب‌ها',
    'designer.variables': 'متغیرها',
    'designer.output': 'خروجی',
    'designer.output.hint': 'فایل دستور را دانلود کنید، کپی کنید یا مستقیم به دستگاه وصل‌شده بفرستید.',
    'troubleshoot.title': 'سرویس و رفع عیب',
    'troubleshoot.subtitle': 'تست خودکار، کالیبراسیون، تمیزکاری هد، شمارنده‌ها، کنسول خام و وضعیت زنده.',
    'troubleshoot.group.test': 'تست‌ها',
    'troubleshoot.group.status': 'وضعیت',
    'troubleshoot.group.maintenance': 'سرویس',
    'troubleshoot.group.config': 'تنظیمات',
    'troubleshoot.console': 'کنسول ارسال دستور خام',
    'troubleshoot.console.hint': 'هگز (1B 40) یا متن با کاراکترهای فرار (\\x1b@). با Ctrl+Enter ارسال می‌شود.',
    'troubleshoot.logs': 'لاگ دستگاه',
    'troubleshoot.export.config': 'پشتیبان‌گیری از تنظیمات',
    'troubleshoot.restore.config': 'بازگرداندن تنظیمات',
    'device.status': 'وضعیت دستگاه',
    'device.host': 'آدرس دستگاه',
    'device.host.hint': 'arsin_print_server.local یا آی‌پی یا آدرس کامل با پورت.',
    'device.apikey': 'کلید API (اختیاری)',
    'device.online': 'آنلاین',
    'device.offline': 'آفلاین',
    'device.demo': 'حالت نمایشی (دستگاهی وصل نیست)',
    'wizard.requirements': 'نیازمندی‌ها',
    'common.transport': 'روش اتصال',
    'common.board': 'برد',
    'common.family': 'خانواده',
    'common.vendor': 'سازنده',
    'common.mcu': 'میکروکنترلر',
    'common.radios': 'بی‌سیم‌ها',
    'common.power': 'تغذیه',
    'common.pins': 'پین‌ها',
    'common.notes': 'نکته‌ها',
    'common.features': 'امکانات',
    'common.capabilities': 'قابلیت‌ها',
    'common.cables': 'کابل‌ها',
    'common.noresults': 'موردی با این فیلتر پیدا نشد.',
    'common.optional': 'اختیاری',
    'common.required': 'الزامی',
    'common.signal': 'سیگنال',
    'common.boardSide': 'برد',
    'common.printerSide': 'پرینتر',
    'common.confidence': 'درجه اطمینان',
    'common.confidence.standard': 'استاندارد',
    'common.confidence.vendor': 'مخصوص سازنده',
    'common.confidence.approximate': 'تقریبی - بررسی کنید',
    'custom.board.add': 'افزودن برد',
    'custom.board.hint': 'یک شیء JSON برد را بچسبانید (مثل آیتم‌های data/boards.json) یا فایل را بارگذاری کنید.',
    'custom.board.saved': 'بردهای سفارشی فقط در همین مرورگر ذخیره می‌شوند.',
    'footer.rights': 'ساخته شده برای سازندگان، تعمیرکاران و مجتمع‌کنندگان فروشگاهی.'
  }
};

let current = 'en';
const listeners = new Set();

export function availableLanguages() {
  return Object.keys(DICT);
}

export function getLanguage() {
  return current;
}

export function t(key, fallback) {
  const d = DICT[current] || DICT.en;
  return d[key] != null ? d[key] : DICT.en[key] != null ? DICT.en[key] : fallback != null ? fallback : key;
}

export function setLanguage(lang) {
  current = DICT[lang] ? lang : 'en';
  const html = document.documentElement;
  html.lang = current;
  html.dir = current === 'fa' ? 'rtl' : 'ltr';
  try {
    localStorage.setItem('arsin.lang', current);
  } catch (e) {
    /* storage disabled - ignore */
  }
  applyTranslations(document);
  for (const fn of listeners) {
    // A listener that belongs to a page which is no longer mounted (or that
    // fails for any other reason) must never break language switching.
    try {
      fn(current);
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) console.warn('i18n listener failed:', e && e.message);
    }
  }
}

/** Apply data-i18n / data-i18n-attr attributes inside a root element. */
export function applyTranslations(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'));
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.getAttribute('data-i18n-html'));
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.getAttribute('data-i18n-attr').split(';')) {
      const [attr, key] = pair.split('=').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initI18n() {
  let saved = 'en';
  try {
    saved = localStorage.getItem('arsin.lang') || (navigator.language || 'en').slice(0, 2);
  } catch (e) {
    saved = 'en';
  }
  setLanguage(DICT[saved] ? saved : 'en');
}
