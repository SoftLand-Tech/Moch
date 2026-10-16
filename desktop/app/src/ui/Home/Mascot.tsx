/** The brand mascot in its greeting pose — the same art the chat empty
 * state inlines (desktop/ui/public/brand/mochi-greeting.svg). Gradient
 * stops are classed so every color, token-following or brand shading,
 * lives in home.css: no hex in TSX. Rendered bright — no dimming filter;
 * this is the hero, not a watermark. */
export function Mascot({ size = 96 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1254 1254"
      aria-hidden
      className="moch-home__art"
    >
      <defs>
        <linearGradient id="mh-sprout" x1="790" y1="380" x2="950" y2="265" gradientUnits="userSpaceOnUse">
          <stop offset="0%" className="mh-stop sprout-a" />
          <stop offset="55%" className="mh-stop sprout-b" />
          <stop offset="100%" className="mh-stop sprout-c" />
        </linearGradient>
        <linearGradient id="mh-body" x1="627" y1="330" x2="627" y2="990" gradientUnits="userSpaceOnUse">
          <stop offset="0%" className="mh-stop body-a" />
          <stop offset="68%" className="mh-stop body-b" />
          <stop offset="78%" className="mh-stop body-c" />
          <stop offset="88%" className="mh-stop body-d" />
          <stop offset="96%" className="mh-stop body-e" />
          <stop offset="100%" className="mh-stop body-f" />
        </linearGradient>
        <linearGradient id="mh-visor" x1="627" y1="420" x2="627" y2="812" gradientUnits="userSpaceOnUse">
          <stop offset="0%" className="mh-stop visor-a" />
          <stop offset="100%" className="mh-stop visor-b" />
        </linearGradient>
        <linearGradient id="mh-hand" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" className="mh-stop hand-a" />
          <stop offset="50%" className="mh-stop hand-b" />
          <stop offset="100%" className="mh-stop hand-c" />
        </linearGradient>
      </defs>
      <path
        d="M 780 375 C 820 410, 835 365, 890 350 C 945 350, 972 310, 960 286 C 958 264, 940 260, 910 255 C 872 255, 832 275, 806 310 C 770 348, 772 370, 780 375 Z"
        fill="url(#mh-sprout)"
      />
      <path
        d="M 627 335 C 730 335, 835 375, 905 440 C 960 495, 974 570, 974 645 C 974 770, 930 870, 835 940 C 775 985, 700 985, 627 985 C 554 985, 479 985, 419 940 C 324 870, 280 770, 280 645 C 280 570, 294 495, 349 440 C 419 375, 524 335, 627 335 Z"
        fill="url(#mh-body)"
      />
      <path
        d="M 627 420 C 725 420, 815 440, 858 480 C 892 515, 897 565, 897 615 C 897 670, 890 720, 855 758 C 812 795, 725 812, 627 812 C 529 812, 442 795, 399 758 C 364 720, 357 670, 357 615 C 357 565, 362 515, 396 480 C 439 440, 529 420, 627 420 Z"
        fill="url(#mh-visor)"
      />
      <g className="mh-eyes">
        <path d="M 457 655 C 446 655, 439 646, 439 634 C 439 598, 468 572, 505 572 C 542 572, 571 598, 571 634 C 571 646, 564 655, 553 655 C 543 655, 537 646, 536 635 C 533 618, 521 608, 505 608 C 489 608, 477 618, 474 635 C 473 646, 467 655, 457 655 Z" />
        <path d="M 797 655 C 808 655, 815 646, 815 634 C 815 598, 786 572, 749 572 C 712 572, 683 598, 683 634 C 683 646, 690 655, 701 655 C 711 655, 717 646, 718 635 C 721 618, 733 608, 749 608 C 765 608, 777 618, 780 635 C 781 646, 787 655, 797 655 Z" />
      </g>
      <g className="mh-blush">
        <ellipse cx="442" cy="695" rx="24" ry="12" transform="rotate(35 442 695)" />
        <ellipse cx="482" cy="705" rx="22" ry="12" transform="rotate(22 482 705)" />
        <ellipse cx="812" cy="695" rx="24" ry="12" transform="rotate(-35 812 695)" />
        <ellipse cx="772" cy="705" rx="22" ry="12" transform="rotate(-22 772 705)" />
      </g>
      <ellipse cx="790" cy="980" rx="52" ry="34" transform="rotate(-12 790 980)" fill="url(#mh-hand)" />
    </svg>
  )
}
