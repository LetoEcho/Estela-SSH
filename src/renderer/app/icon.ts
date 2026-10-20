import { Component, input } from '@angular/core';

/** Renders an emoji or a custom image icon (data: URL). */
@Component({
  selector: 'app-icon',
  template: `
    @if (icon().startsWith('data:')) {
      <img [src]="icon()" alt="" />
    } @else {
      {{ icon() }}
    }
  `,
  styles: `
    :host { display: inline-flex; width: 16px; justify-content: center; flex: none; }
    img { width: 16px; height: 16px; object-fit: contain; }
  `,
})
export class Icon {
  readonly icon = input.required<string>();
}
