package io.github.pipo3355.anixartoffline;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Прокси для онлайн-просмотра. CDN видео часто не присылают CORS-заголовки, и hls.js
 * в приложении не может читать их плейлисты. Поэтому плеер запрашивает
 *   https://localhost/_proxy/https/cdn.host/path/file.m3u8?query
 * а мы здесь сами скачиваем https://cdn.host/path/file.m3u8?query и отдаём ответ
 * как будто с того же адреса, что и приложение. Относительные ссылки на куски видео
 * внутри плейлиста при этом тоже попадают в прокси. (На ПК то же делает webRequest.)
 */
final class MediaProxy {

    static final String PREFIX = "/_proxy/";
    private static final String UA =
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";

    private MediaProxy() {}

    static boolean handles(Uri uri) {
        String path = uri.getEncodedPath();
        return "localhost".equals(uri.getHost()) && path != null && path.startsWith(PREFIX);
    }

    /** https://localhost/_proxy/https/host/a/b?q → https://host/a/b?q */
    static String target(Uri uri) {
        String rest = uri.getEncodedPath().substring(PREFIX.length()); // "https/host/a/b"
        int slash = rest.indexOf('/');
        if (slash <= 0) return null;
        String scheme = rest.substring(0, slash);
        if (!scheme.equals("https") && !scheme.equals("http")) return null;
        String q = uri.getEncodedQuery();
        return scheme + "://" + rest.substring(slash + 1) + (q != null ? "?" + q : "");
    }

    static WebResourceResponse fetch(WebResourceRequest request) {
        Map<String, String> cors = new HashMap<>();
        cors.put("Access-Control-Allow-Origin", "*");
        cors.put("Access-Control-Allow-Headers", "*");
        try {
            String url = target(request.getUrl());
            if (url == null) return error(400, "Bad Request", cors);
            if ("OPTIONS".equals(request.getMethod())) {
                return new WebResourceResponse("text/plain", "utf-8", 204, "No Content", cors, null);
            }
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(20_000);
            c.setReadTimeout(45_000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", UA);
            c.setRequestProperty("Accept-Encoding", "identity");
            String range = header(request.getRequestHeaders(), "Range");
            if (range != null) c.setRequestProperty("Range", range);
            if (url.contains("sibnet")) c.setRequestProperty("Referer", "https://video.sibnet.ru/");
            int code = c.getResponseCode();
            InputStream body = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String type = c.getContentType();
            String mime = type != null ? type.split(";")[0].trim() : "application/octet-stream";
            Map<String, String> headers = new HashMap<>(cors);
            for (Map.Entry<String, List<String>> h : c.getHeaderFields().entrySet()) {
                String k = h.getKey();
                if (k == null || h.getValue() == null || h.getValue().isEmpty()) continue;
                String lk = k.toLowerCase();
                if (lk.startsWith("access-control-") || lk.equals("content-encoding") || lk.equals("transfer-encoding")
                        || lk.equals("set-cookie") || lk.equals("connection")) continue;
                headers.put(k, h.getValue().get(0));
            }
            String reason = c.getResponseMessage();
            if (reason == null || reason.isEmpty()) reason = code == 206 ? "Partial Content" : "OK";
            return new WebResourceResponse(mime, null, code, reason, headers, body);
        } catch (Exception e) {
            return error(502, "Bad Gateway", cors);
        }
    }

    private static String header(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> h : headers.entrySet()) {
            if (h.getKey() != null && h.getKey().equalsIgnoreCase(name)) return h.getValue();
        }
        return null;
    }

    private static WebResourceResponse error(int code, String reason, Map<String, String> headers) {
        return new WebResourceResponse("text/plain", "utf-8", code, reason, headers,
                new java.io.ByteArrayInputStream(new byte[0]));
    }
}
