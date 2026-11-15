// Applied only by generated listings; ordinary user listings retain their own setup.
export const CODE_WRAPPING_OPTIONS = ',breaklines=true,breakatwhitespace=false,columns=fullflexible,keepspaces=true,showstringspaces=false,basicstyle=\\ModuTeXCodeWrap';

// Bound listings' token boxes and physical-line width counters without modifying code.
// Both definitions are local to the listing's Init group, including the hook append.
export const CODE_WRAPPING_PREAMBLE = String.raw`\makeatletter
\newcommand{\ModuTeXCodeWrap}{%
  \ttfamily
  \let\modutex@savedAppend\lst@Append
  \def\lst@Append##1{%
    \modutex@savedAppend{##1}%
    \ifnum\lst@length>31 \lst@PrintToken\fi}%
  \lst@lAddTo\lsthk@PostOutput{%
    \global\lst@currlwidth\z@
    \global\lst@lostspace\z@}}
\makeatother`;
