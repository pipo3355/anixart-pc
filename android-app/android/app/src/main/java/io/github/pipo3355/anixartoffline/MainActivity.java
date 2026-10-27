package io.github.pipo3355.anixartoffline;

import android.content.res.Configuration;
import android.os.Bundle;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // свой плагин нужно зарегистрировать до запуска моста
        registerPlugin(DevicePlugin.class);
        super.onCreate(savedInstanceState);
        // онлайн-просмотр: видео с CDN без CORS идёт через MediaProxy
        getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (MediaProxy.handles(request.getUrl())) return MediaProxy.fetch(request);
                return super.shouldInterceptRequest(view, request);
            }
        });
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        PluginHandle handle = getBridge().getPlugin("Device");
        if (handle != null && handle.getInstance() instanceof DevicePlugin) {
            ((DevicePlugin) handle.getInstance()).onPipChanged(isInPictureInPictureMode);
        }
    }
}
