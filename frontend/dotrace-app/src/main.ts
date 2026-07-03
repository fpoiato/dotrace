import { bootstrapApplication } from '@angular/platform-browser';
import { TranslateService } from '@ngx-translate/core';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, appConfig)
  .then((ref) => {
    const translate = ref.injector.get(TranslateService);
    const lang = localStorage.getItem('dotrace-lang') ?? 'pt-BR';
    translate.setDefaultLang('pt-BR');
    translate.use(lang);
  })
  .catch((err) => console.error(err));
