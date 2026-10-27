package io.github.pipo3355.anixartoffline;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Загрузка большого файла с докачкой: если файл уже частично скачан, просим у сервера
 * только недостающее (заголовок Range) и дописываем в конец. Так смена сети или пауза
 * не начинают серию заново. Загрузку можно отменить — недокачанный файл остаётся.
 */
class ResumableDownloader {

    interface Listener {
        void progress(long bytes, long total);
    }

    interface Done {
        void ok(long size, long total);
        void fail(Exception e);
    }

    static class HttpError extends IOException {
        HttpError(String msg) { super(msg); }
    }

    static class Canceled extends IOException {
        Canceled() { super("Отменено"); }
    }

    private static final Pattern CONTENT_RANGE = Pattern.compile("bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)");
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, AtomicBoolean> cancels = new ConcurrentHashMap<>();
    private final Map<String, Future<?>> running = new ConcurrentHashMap<>();

    void start(String id, String url, String path, Map<String, String> headers, long expectTotal, Listener listener, Done done) {
        // предыдущая загрузка с тем же id (быстрые «пауза → продолжить») — останавливаем и ждём её
        cancel(id);
        final Future<?> previous = running.get(id);
        final AtomicBoolean cancel = new AtomicBoolean(false);
        cancels.put(id, cancel);
        Future<?> f = pool.submit(() -> {
            try {
                if (previous != null) {
                    try { previous.get(); } catch (Exception ignored) {}
                }
                long[] r = download(url, new File(path), headers, expectTotal, listener, cancel);
                done.ok(r[0], r[1]);
            } catch (Exception e) {
                done.fail(e);
            } finally {
                cancels.remove(id, cancel);
            }
        });
        running.put(id, f);
    }

    void cancel(String id) {
        AtomicBoolean c = cancels.get(id);
        if (c != null) c.set(true);
    }

    private long[] download(String url, File file, Map<String, String> headers, long expectTotal,
                            Listener listener, AtomicBoolean cancel) throws IOException {
        File parent = file.getParentFile();
        if (parent != null) parent.mkdirs();
        for (int pass = 0; pass < 2; pass++) {
            if (cancel.get()) throw new Canceled();
            long have = file.exists() ? file.length() : 0;
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(20_000);
            c.setReadTimeout(45_000);
            c.setInstanceFollowRedirects(true);
            for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
            c.setRequestProperty("Accept-Encoding", "identity");
            if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
            try {
                int code = c.getResponseCode();
                long total;
                boolean append;
                if (code == 206) {
                    Matcher m = CONTENT_RANGE.matcher(String.valueOf(c.getHeaderField("Content-Range")));
                    long start = -1;
                    total = -1;
                    if (m.find()) {
                        start = Long.parseLong(m.group(1));
                        if (!"*".equals(m.group(3))) total = Long.parseLong(m.group(3));
                    }
                    // сервер ответил не с того места или это другой файл (ссылка сменилась на другое качество)
                    if (start != have || (expectTotal > 0 && total > 0 && total != expectTotal)) {
                        file.delete();
                        continue;
                    }
                    append = true;
                } else if (code == 200) {
                    // сервер не умеет докачку — начинаем сначала
                    have = 0;
                    append = false;
                    total = c.getContentLengthLong();
                } else if (code == 416 && have > 0) {
                    // «нечего отдавать»: файл уже скачан целиком, если размер совпадает с ожидаемым
                    if (expectTotal > 0 && have == expectTotal) return new long[] { have, have };
                    file.delete();
                    continue;
                } else {
                    throw new HttpError("HTTP " + code);
                }
                listener.progress(have, total);
                byte[] buf = new byte[256 * 1024];
                long bytes = have;
                long lastReport = 0;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(file, append)) {
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        if (cancel.get()) throw new Canceled();
                        out.write(buf, 0, n);
                        bytes += n;
                        long now = System.currentTimeMillis();
                        if (now - lastReport > 500) {
                            lastReport = now;
                            listener.progress(bytes, total);
                        }
                    }
                }
                if (total > 0 && bytes < total) throw new IOException("Соединение оборвалось");
                listener.progress(bytes, total);
                return new long[] { bytes, total > 0 ? total : bytes };
            } finally {
                c.disconnect();
            }
        }
        throw new IOException("Сервер не дал продолжить загрузку");
    }
}
