import { Component, input } from '@angular/core';

/** Renders an emoji or a custom image icon (data: URL). */
@Component({
  selector: 'app-icon',
  template: `
    @if (icon().startsWith('data:')) {
      <img [src]="icon()" alt="" [style.width.px]="size()" [style.height.px]="size()" />
    } @else {
      {{ icon() }}
    }
  `,
  host: { '[style.width.px]': 'size()', '[style.font-size.px]': 'size() === 16 ? null : size() * 0.85' },
  styles: `
    :host { display: inline-flex; justify-content: center; align-items: center; flex: none; }
    img { object-fit: contain; }
  `,
})
export class Icon {
  readonly icon = input.required<string>();
  readonly size = input(16);
}
