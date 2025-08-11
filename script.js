 // Основной скрипт для отслеживания посылок
class PackageTracker {
    constructor() {
        // Источники данных (Google Sheets CSV)
        this.ordersCsvUrl = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQModmlHL0Nh-vN18dxXMtRhuOd2P2owMk-G4qhfhYyJQpQz60VgRBD3-XzW54IvMsB8kjI6H9yJNnJ/pub?gid=526359759&single=true&output=csv';
        this.batchesCsvUrl = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQModmlHL0Nh-vN18dxXMtRhuOd2P2owMk-G4qhfhYyJQpQz60VgRBD3-XzW54IvMsB8kjI6H9yJNnJ/pub?gid=0&single=true&output=csv';

        // Кэш данных для повторных запросов
        this.orders = null;   // [{ tracking_number, batch_id }]
        this.batches = null;  // [{ batch_id, date, status }]

        this.currentTrackingNumber = '';

        // Внутренняя шкала для прогресса (по желанию)
        this.statuses = [
            'Отправлен из Китая',
            'Прошел таможенный контроль',
            'В пути по России',
            'Прибыл на склад в Москве',
            'Готов к выдаче'
        ];
        
        this.init();
    }

    // Инициализация приложения
    init() {
        this.bindEvents();
        this.setupAnimations();
    }

    // Привязка событий к элементам
    bindEvents() {
        const trackButton = document.getElementById('trackButton');
        const trackingInput = document.getElementById('trackingInput');

        trackButton.addEventListener('click', () => {
            this.trackPackage();
        });

        trackingInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.trackPackage();
            }
        });

        trackingInput.focus();
    }

    // Настройка анимаций
    setupAnimations() {
        const elements = document.querySelectorAll('.header, .tracking-form');
        elements.forEach((el, index) => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(30px)';
            
            setTimeout(() => {
                el.style.transition = 'all 0.6s ease';
                el.style.opacity = '1';
                el.style.transform = 'translateY(0)';
            }, index * 200);
        });
    }

    // ---- CSV helpers ----
    async fetchCsv(url) {
        const bustUrl = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
        const res = await fetch(bustUrl, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Ошибка загрузки CSV: ${res.status}`);
        const text = await res.text();
        return this.parseCsv(text);
    }

    // Простой парсер CSV с поддержкой кавычек и запятых в значениях
    parseCsv(csvText) {
        const rows = [];
        const lines = csvText.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim().length > 0);
        if (lines.length === 0) return rows;
        const headers = this.splitCsvLine(lines[0]).map(h => h.trim());
        for (let i = 1; i < lines.length; i++) {
            const cells = this.splitCsvLine(lines[i]);
            if (cells.length === 1 && cells[0] === '') continue;
            const obj = {};
            headers.forEach((h, idx) => {
                obj[h] = (cells[idx] ?? '').trim();
            });
            rows.push(obj);
        }
        return rows;
    }

    splitCsvLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (inQuotes && line[i + 1] === '"') { // escaped quote
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (ch === ',' && !inQuotes) {
                result.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        result.push(current);
        return result;
    }

    // Нормализация ключа и чтение значения по альтернативным названиям столбцов
    normalizeKey(key) {
        return String(key || '')
            .toLowerCase()
            .replace(/\s+/g, '')
            .replace(/_/g, '')
            .replace(/\u00A0/g, ''); // неразрывные пробелы
    }

    getField(row, candidates) {
        if (!row) return '';
        const map = {};
        for (const k of Object.keys(row)) {
            map[this.normalizeKey(k)] = k;
        }
        for (const candidate of candidates) {
            const norm = this.normalizeKey(candidate);
            if (map[norm] !== undefined) {
                const v = row[map[norm]];
                return typeof v === 'string' ? v.trim() : v;
            }
        }
        return '';
    }

    // Нечёткий (по вхождению) поиск столбца
    getFieldFuzzy(row, includeTokens) {
        if (!row) return '';
        const entries = Object.entries(row);
        const normTokens = includeTokens.map(t => this.normalizeKey(t));
        for (const [key, value] of entries) {
            const normKey = this.normalizeKey(key);
            if (normTokens.some(t => normKey.includes(t))) {
                return typeof value === 'string' ? value.trim() : value;
            }
        }
        return '';
    }

    // Нормализация текстового значения (значения ячеек)
    normalizeValue(value) {
        return String(value || '')
            .replace(/\u00A0/g, ' ')   // неразрывные пробелы -> обычные
            .replace(/\s+/g, ' ')      // схлопнуть подряд идущие пробелы
            .trim();
    }

    async ensureOrdersLoaded(force = false) {
        if (force || !this.orders) {
            this.orders = await this.fetchCsv(this.ordersCsvUrl);
        }
        return this.orders;
    }

    async ensureBatchesLoaded(force = false) {
        if (force || !this.batches) {
            this.batches = await this.fetchCsv(this.batchesCsvUrl);
        }
        return this.batches;
    }

    // Поиск посылки по трек-номеру в orders.csv
    async findOrderByTracking(trackingNumber) {
        const orders = await this.ensureOrdersLoaded();
        return orders.find(r => {
            const tn = this.getField(r, [
                'tracking_number', 'tracking', 'trackingnumber',
                'трек', 'трекномер', 'трек-номер', 'трек номер'
            ]);
            return (tn || '').toLowerCase() === trackingNumber.toLowerCase();
        }) || null;
    }

    // Поиск партии по batch_id в batches.csv
    async findBatchById(batchId) {
        const batches = await this.ensureBatchesLoaded();
        return batches.find(r => {
            const id = this.getField(r, ['batch_id', 'batchid', 'batch', 'партия', 'idпартии', 'id партии']);
            return (id || '').trim() === String(batchId).trim();
        }) || null;
    }

    // Нормализация статуса из batches.csv к нашей внутренней шкале
    normalizeStatus(externalStatus) {
        const cleaned = this.normalizeValue(externalStatus);
        if (!cleaned) return '';
        const exact = this.statuses.find(s => this.normalizeValue(s).toLowerCase() === cleaned.toLowerCase());
        if (!exact) {
            console.warn('Статус в таблице не из списка допустимых:', cleaned);
            return '';
        }
        return exact;
    }

    // Основная функция отслеживания
    async trackPackage() {
        const trackingNumber = document.getElementById('trackingInput').value.trim();
        const btn = document.getElementById('trackButton');

        if (!trackingNumber) {
            this.showError('Пожалуйста, введите трек-номер');
            return;
        }

        const stopLoading = UIUtils.showLoading(btn);
        this.currentTrackingNumber = trackingNumber;
        this.hideAllResults();

        try {
            // Обновляем данные, чтобы подтянуть последние изменения из таблицы
            await Promise.all([this.ensureOrdersLoaded(true), this.ensureBatchesLoaded(true)]);
            // 1) Ищем заказ в orders.csv
            const order = await this.findOrderByTracking(trackingNumber);
            if (!order) {
                this.showNotFound();
                stopLoading();
                return;
            }

            // 2) Берём batch_id и загружаем партию
            const batchId = this.getField(order, ['batch_id', 'batchid', 'batch', 'партия', 'idпартии', 'id партии']);
            const batch = await this.findBatchById(batchId);
            if (!batch) {
                this.showError('Партия не найдена');
                stopLoading();
                return;
            }

            // 3) Готовим объект для отображения
            const rawDate = this.getField(batch, ['date', 'дата', 'датаотправки', 'дата отправки', 'shipment_date', 'shipdate'])
                || this.getFieldFuzzy(batch, ['date', 'дата', 'ship', 'shipment', 'отправ']);
            const rawStatus = this.getField(batch, ['status', 'статус'])
                || this.getFieldFuzzy(batch, ['status', 'статус']);

            if (!rawDate) {
                // Диагностика в консоль: покажем ключи строки партии
                console.warn('Дата не найдена. Доступные поля партии:', Object.keys(batch));
            }

            const parcel = { tracking_number: trackingNumber, status: this.normalizeStatus(rawStatus) };

            this.fillBatchMeta(rawDate || '', batchId);
            this.showTrackingResult(parcel);
        } catch (err) {
            console.error(err);
            this.showError('Ошибка загрузки данных. Попробуйте позже.');
        } finally {
            stopLoading();
        }
    }

    // Заполнение метаданных партии
    fillBatchMeta(date, batchId) {
        const dateEl = document.getElementById('dateText');
        const batchEl = document.getElementById('batchIdText');
        if (dateEl) dateEl.textContent = date || '—';
        if (batchEl) batchEl.textContent = batchId || '—';
    }

    // Показать результат отслеживания
    showTrackingResult(parcel) {
        const resultDiv = document.getElementById('trackingResult');
        const resultTitle = document.getElementById('resultTitle');
        const displayTrackingNumber = document.getElementById('displayTrackingNumber');
        const currentStatusText = document.getElementById('currentStatusText');
        const progressFill = document.getElementById('progressFill');

        resultTitle.textContent = 'Посылка найдена!';
        displayTrackingNumber.textContent = parcel.tracking_number;
        currentStatusText.textContent = parcel.status || 'Статус недоступен';

        // Расчёт прогресса по нашей шкале, если распознали статус
        const normalizedIndex = this.statuses.indexOf(parcel.status);
        const progressPercent = normalizedIndex >= 0 ? ((normalizedIndex + 1) / this.statuses.length) * 100 : 0;

        setTimeout(() => {
            progressFill.style.width = progressPercent + '%';
        }, 100);

        this.updateProgressSteps(parcel.status);

        resultDiv.classList.remove('hidden');
        resultDiv.style.opacity = '0';
        resultDiv.style.transform = 'translateY(20px)';
        setTimeout(() => {
            resultDiv.style.transition = 'all 0.5s ease';
            resultDiv.style.opacity = '1';
            resultDiv.style.transform = 'translateY(0)';
        }, 50);
    }

    // Обновление шагов прогресса
    updateProgressSteps(currentStatus) {
        const steps = document.querySelectorAll('.step');
        const idx = this.statuses.indexOf(currentStatus);
        steps.forEach((step, i) => {
            step.classList.toggle('active', idx >= 0 && i <= idx);
        });
    }

    // Показать сообщение "не найдено"
    showNotFound() {
        const errorDiv = document.getElementById('errorMessage');
        errorDiv.classList.remove('hidden');
        errorDiv.style.opacity = '0';
        errorDiv.style.transform = 'scale(0.9)';
        setTimeout(() => {
            errorDiv.style.transition = 'all 0.3s ease';
            errorDiv.style.opacity = '1';
            errorDiv.style.transform = 'scale(1)';
        }, 50);
    }

    // Показать ошибку
    showError(message) {
        const errorDiv = document.getElementById('errorMessage');
        const errorText = errorDiv.querySelector('p');
        errorText.textContent = message;
        errorDiv.classList.remove('hidden');
        errorDiv.style.opacity = '0';
        errorDiv.style.transform = 'scale(0.9)';
        setTimeout(() => {
            errorDiv.style.transition = 'all 0.3s ease';
            errorDiv.style.opacity = '1';
            errorDiv.style.transform = 'scale(1)';
        }, 50);
    }

    // Скрыть все результаты
    hideAllResults() {
        document.getElementById('trackingResult').classList.add('hidden');
        document.getElementById('errorMessage').classList.add('hidden');
        this.fillBatchMeta('', '');
        const progressFill = document.getElementById('progressFill');
        if (progressFill) progressFill.style.width = '0%';
        this.updateProgressSteps('');
    }

    // Сброс кэша
    async refreshData() {
        this.orders = null;
        this.batches = null;
        await Promise.all([this.ensureOrdersLoaded(), this.ensureBatchesLoaded()]);
        console.log('Данные обновлены');
    }
}

// Утилиты
class UIUtils {
    static typewriterEffect(element, text, speed = 50) {
        element.textContent = '';
        let i = 0;
        const timer = setInterval(() => {
            element.textContent += text.charAt(i);
            i++;
            if (i >= text.length) clearInterval(timer);
        }, speed);
    }

    static showLoading(button) {
        const textSpan = button.querySelector('.button-text');
        const originalText = textSpan.textContent;
        textSpan.textContent = 'Поиск...';
        button.disabled = true;
        return () => {
            textSpan.textContent = originalText;
            button.disabled = false;
        };
    }

    static validateTrackingNumber(number) {
        return number.length >= 3 && number.length <= 40;
    }
}

// Инициализация
document.addEventListener('DOMContentLoaded', () => {
    window.packageTracker = new PackageTracker();
    window.refreshData = () => window.packageTracker.refreshData();
    window.clearInput = () => window.packageTracker.clearInput?.();
    console.log('Приложение "Китай-город" инициализировано');
});

// Обработка ошибок
window.addEventListener('error', (e) => {
    console.error('Глобальная ошибка:', e.error);
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('Необработанная ошибка промиса:', e.reason);
});